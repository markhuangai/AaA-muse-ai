package media

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"math"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

type probeStream struct {
	Type   string `json:"codec_type"`
	Codec  string `json:"codec_name"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	Rate   string `json:"avg_frame_rate"`
	Frames string `json:"nb_read_frames"`
}
type probeResult struct {
	Streams []probeStream `json:"streams"`
	Format  struct {
		Duration string `json:"duration"`
	} `json:"format"`
}

type cappedOutput struct{ buf bytes.Buffer }

func (b *cappedOutput) Write(p []byte) (int, error) {
	if b.buf.Len()+len(p) > 64<<10 {
		return 0, errors.New("probe_output_limit")
	}
	return b.buf.Write(p)
}
func runProcess(ctx context.Context, program string, args []string, stdout io.Writer) error {
	cmd := exec.CommandContext(ctx, program, args...)
	cmd.Stdout = stdout
	return cmd.Run()
}

func (s *Store) command(ctx context.Context, program string, args ...string) ([]byte, error) {
	var out cappedOutput
	err := s.run(ctx, program, args, &out)
	if err != nil {
		var missing *exec.Error
		if errors.As(err, &missing) {
			return nil, errors.New("media_decoder_unavailable")
		}
		if ctx.Err() != nil {
			return nil, inference.Reject("media_inspection_timeout", 422)
		}
		return nil, inference.Reject("media_decode_failed", 422)
	}
	return out.buf.Bytes(), nil
}

func (s *Store) imageFormat(path, kind string) (string, error) {
	data, err := s.files.open(path)
	if err != nil {
		return "", err
	}
	defer data.Close()
	var header [24]byte
	_, err = io.ReadFull(data, header[:])
	if err != nil {
		return "", inference.Reject("invalid_media_format", 422)
	}
	switch kind {
	case "image/jpeg":
		if bytes.HasPrefix(header[:], []byte{0xff, 0xd8, 0xff}) {
			return "jpeg_pipe", nil
		}
	case "image/webp":
		if string(header[:4]) == "RIFF" && string(header[8:12]) == "WEBP" {
			if string(header[12:16]) == "VP8X" && header[20]&2 != 0 {
				return "", inference.Reject("animated_reference", 422)
			}
			return "webp_pipe", nil
		}
	case "image/png":
		if !bytes.Equal(header[:8], []byte{137, 80, 78, 71, 13, 10, 26, 10}) {
			break
		}
		if _, err = data.Seek(8, io.SeekStart); err != nil {
			return "", err
		}
		for {
			var chunk [8]byte
			if _, err = io.ReadFull(data, chunk[:]); err != nil {
				break
			}
			switch string(chunk[4:]) {
			case "acTL":
				return "", inference.Reject("animated_reference", 422)
			case "IDAT":
				return "png_pipe", nil
			}
			if _, err = data.Seek(int64(binary.BigEndian.Uint32(chunk[:4]))+4, io.SeekCurrent); err != nil {
				return "", err
			}
		}
	case "video/mp4":
		if string(header[4:8]) == "ftyp" {
			return "mov", nil
		}
	case "audio/wav":
		if string(header[:4]) == "RIFF" && string(header[8:12]) == "WAVE" {
			return "wav", nil
		}
	case "audio/mpeg":
		return "mp3", nil
	}
	return "", inference.Reject("invalid_media_format", 422)
}

func (s *Store) probe(ctx context.Context, args []string, count bool) (probeResult, error) {
	options := []string{"-show_entries", "stream=codec_type,codec_name,width,height,avg_frame_rate,nb_read_frames:format=duration", "-of", "json"}
	if count {
		options = append(options, "-count_frames")
	}
	output, err := s.command(ctx, "ffprobe", append(options, args...)...)
	var result probeResult
	if err == nil {
		err = json.Unmarshal(output, &result)
	}
	return result, err
}
func rate(value string) float64 {
	a, b, ok := strings.Cut(value, "/")
	n, e := strconv.ParseFloat(a, 64)
	if e != nil {
		return 0
	}
	if !ok {
		return n
	}
	d, e := strconv.ParseFloat(b, 64)
	if e != nil || d <= 0 {
		return 0
	}
	return n / d
}

func (s *Store) inspect(parent context.Context, path, kind string) (inference.MediaProperties, error) {
	var props inference.MediaProperties
	format, err := s.imageFormat(path, kind)
	if err != nil {
		return props, err
	}
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	args := []string{"-v", "error", "-max_alloc", "134217728", "-protocol_whitelist", "file", "-threads", "1", "-f", format, "-i", path}
	first, err := s.probe(ctx, args, false)
	if err != nil {
		return props, err
	}
	image := strings.HasPrefix(kind, "image/")
	wantVideo := image || kind == "video/mp4"
	video, audio := 0, 0
	for _, s := range first.Streams {
		switch s.Type {
		case "video":
			video++
			if s.Width <= 0 || s.Height <= 0 || (image && int64(s.Width)*int64(s.Height) > PixelLimit) {
				return props, inference.Reject("invalid_media_dimensions", 422)
			}
		case "audio":
			audio++
		default:
			return props, inference.Reject("unexpected_media_stream", 422)
		}
	}
	if wantVideo && video != 1 || image && audio != 0 || !wantVideo && (video != 0 || audio != 1) {
		return props, inference.Reject("unexpected_media_stream", 422)
	}
	full, err := s.probe(ctx, args, true)
	if err != nil {
		return props, err
	}
	for _, s := range full.Streams {
		props.Streams = append(props.Streams, inference.MediaStream{Type: s.Type, Codec: s.Codec})
		if s.Type == "video" {
			props.Width, props.Height, props.FPS = s.Width, s.Height, rate(s.Rate)
			props.VideoFrames, err = strconv.Atoi(s.Frames)
			if err != nil || props.VideoFrames < 1 || image && props.VideoFrames != 1 {
				return props, inference.Reject("invalid_frame_count", 422)
			}
		}
	}
	if !image {
		props.Duration, err = strconv.ParseFloat(full.Format.Duration, 64)
		if err != nil || props.Duration <= 0 || math.IsNaN(props.Duration) || math.IsInf(props.Duration, 0) {
			return props, inference.Reject("invalid_media_duration", 422)
		}
	}
	decode := append([]string{"-nostdin", "-xerror"}, args...)
	_, err = s.command(ctx, "ffmpeg", append(decode, "-map", "0", "-threads", "1", "-f", "null", "-")...)
	props.MediaType = kind
	return props, err
}

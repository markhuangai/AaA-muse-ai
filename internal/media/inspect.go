package media

import (
	"context"
	"encoding/binary"
	"errors"
	"image"
	"image/jpeg"
	"image/png"
	"io"

	"github.com/gabriel-vasile/mimetype"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"golang.org/x/image/webp"
)

func (s *Store) checkHeader(ctx context.Context, path, kind string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	data, err := s.files.open(path)
	if err != nil {
		return err
	}
	defer data.Close()

	switch kind {
	case "image/jpeg", "image/png", "image/webp":
		return checkReferenceHeader(data, kind)
	default:
		return checkArtifactHeader(data, kind)
	}
}

func checkReferenceHeader(data io.ReadSeeker, kind string) error {
	var config image.Config
	var err error
	switch kind {
	case "image/jpeg":
		config, err = jpeg.DecodeConfig(data)
	case "image/png":
		config, err = png.DecodeConfig(data)
	case "image/webp":
		var header [24]byte
		if _, err = io.ReadFull(data, header[:]); err != nil {
			return inference.Reject("invalid_media_format", 422)
		}
		if string(header[12:16]) == "VP8X" && header[20]&2 != 0 {
			return inference.Reject("animated_reference", 422)
		}
		if _, err = data.Seek(0, io.SeekStart); err != nil {
			return err
		}
		config, err = webp.DecodeConfig(data)
	}
	if err != nil {
		return inference.Reject("invalid_media_format", 422)
	}
	if config.Width <= 0 || config.Height <= 0 || config.Width > PixelLimit/config.Height {
		return inference.Reject("invalid_media_dimensions", 422)
	}
	if kind == "image/png" {
		return checkPNGAnimation(data)
	}
	return nil
}

func checkPNGAnimation(data io.ReadSeeker) error {
	if _, err := data.Seek(8, io.SeekStart); err != nil {
		return err
	}
	for {
		var chunk [8]byte
		if _, err := io.ReadFull(data, chunk[:]); err != nil {
			return inference.Reject("invalid_media_format", 422)
		}
		switch string(chunk[4:8]) {
		case "acTL":
			return inference.Reject("animated_reference", 422)
		case "IDAT":
			return nil
		}
		if _, err := data.Seek(int64(binary.BigEndian.Uint32(chunk[:4]))+4, io.SeekCurrent); err != nil {
			return err
		}
	}
}

func checkArtifactHeader(data io.Reader, kind string) error {
	var prefix [3072]byte
	n, err := io.ReadFull(data, prefix[:])
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return err
	}
	if n >= 12 {
		switch kind {
		case "video/mp4":
			if string(prefix[4:8]) == "ftyp" {
				return nil
			}
		case "audio/wav":
			if string(prefix[:4]) == "RIFF" && string(prefix[8:12]) == "WAVE" {
				return nil
			}
		case "audio/mpeg":
			if mimetype.Detect(prefix[:n]).Is("audio/mpeg") {
				return nil
			}
		}
	}
	return inference.Reject("invalid_media_format", 422)
}

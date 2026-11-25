package service

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

const DevelopmentVersion = "1.0.0-dev.0"
const WorkerVersionHeader = "X-Muse-Worker-Version"
const ServiceVersionHeader = "X-Muse-Service-Version"
const WorkerUpdaterHeader = "X-Muse-Worker-Updater"
const WorkerDigestHeader = "X-Muse-Worker-SHA256"
const PairedDigestHeader = "X-Muse-Paired-Worker-SHA256"

var sourceRevision = regexp.MustCompile(`^[a-f0-9]{40}$`)
var supportedMajors = regexp.MustCompile(`^(?:[1-9][0-9]*)(?:,[1-9][0-9]*)*$`)

func ValidWorkerDigest(digest string) bool { return archiveDigest.MatchString(digest) }

func (b Build) UpdateTarget() *worker.UpdateTarget {
	b = b.Normalized()
	major, valid := ReleaseMajor(b.Version)
	if !valid || major == 0 || strings.Contains(b.Version, "-dev.") || !archiveDigest.MatchString(b.WorkerPackage.SHA256) ||
		!sourceRevision.MatchString(b.Revision) || (b.WorkerUpdateFrom != "" && !supportedMajors.MatchString(b.WorkerUpdateFrom)) {
		return nil
	}
	return &worker.UpdateTarget{PackagePin: b.WorkerPackage, Source: b.Revision, Contract: worker.UpdateContract, FromMajors: b.WorkerUpdateFrom}
}

var releaseVersion = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(dev|rc)\.(0|[1-9][0-9]*))?$`)
var archiveDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)

func ReleaseMajor(version string) (uint64, bool) {
	parts := releaseVersion.FindStringSubmatch(version)
	if parts == nil {
		return 0, false
	}
	major, err := strconv.ParseUint(parts[1], 10, 64)
	return major, err == nil
}

func PairedWorker(version, digest string) PackagePin {
	return PackagePin{Name: "@markhuangai/aaa-muse-worker", Version: version, SHA256: digest,
		URL: "https://github.com/markhuangai/AaA-muse-ai/releases/download/v" + version + "/markhuangai-aaa-muse-worker-" + version + ".tgz"}
}

func (b Build) Normalized() Build {
	if b.Version == "" {
		b.Version = DevelopmentVersion
	}
	b.WorkerPackage = PairedWorker(b.Version, b.WorkerPackage.SHA256)
	return b
}

func (b Build) Compatible(workerVersion string) bool {
	major, valid := ReleaseMajor(b.Normalized().Version)
	if !valid {
		return false
	}
	if workerVersion == "" {
		return major == 0
	}
	workerMajor, valid := ReleaseMajor(workerVersion)
	return valid && workerMajor == major
}

func (b Build) Paired(contact worker.Contact) bool {
	b = b.Normalized()
	return contact.Version == b.Version && contact.Contract == worker.UpdateContract &&
		ValidWorkerDigest(b.WorkerPackage.SHA256) && contact.Digest == b.WorkerPackage.SHA256
}

func (b Build) Valid() bool {
	b = b.Normalized()
	_, valid := ReleaseMajor(b.Version)
	return valid && (archiveDigest.MatchString(b.WorkerPackage.SHA256) || (b.WorkerPackage.SHA256 == "" && strings.Contains(b.Version, "-dev.")))
}

func (s *Service) Build() Build { return s.build }

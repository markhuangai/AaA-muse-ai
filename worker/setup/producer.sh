#!/bin/sh
set -eu

test "$#" -ge 4
launcher=$1
launch=$2
producer=$3
shift 3

# Keep the recorded PID across exec so settlement can check the producer itself.
"$launcher" cron-producer-bind --launch-id "$launch" --producer-id "$producer" > /dev/null
exec "$@"

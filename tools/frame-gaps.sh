#!/bin/sh
# Prints the distribution of gaps between consecutive presentation timestamps of
# an mp4: the real answer to "what rate does this play at", which a mean frame
# rate hides.
#
#   tools/frame-gaps.sh out.mp4
set -eu
ffprobe -v error -select_streams v:0 -count_frames \
  -show_entries frame=pts_time -of csv=p=0 "$1" \
  | tr -d ',' \
  | awk 'NR>1 { printf "%.3f\n", $1 - p } { p = $1 }' \
  | sort -n | uniq -c \
  | awk '{ printf "%8s ms  x %d\n", $2 * 1000, $1 }'

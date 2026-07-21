# HEVC Fix Script
# NOTE: This script is no longer needed — the MKV remuxer (mkvRemux.js)
# now natively handles HEVC/H.265, VP9, AV1, Opus, AC3, EAC3, FLAC, and more.
#
# The VLC-compatible demuxer converts MKV → fMP4 with proper hvcC configuration
# for HEVC streams, so the Android app and modern browsers can decode them natively.
#
# If you still encounter issues with a specific HEVC file, it likely uses
# a non-standard CodecPrivate format. Check the server logs for:
#   "Proxy: HEVC MKV — remuxing (VLC-compatible)"
#
# Legacy workaround (no longer recommended):
#   ffmpeg -i input.mkv -c:v libx264 -c:a aac -movflags +faststart output.mp4

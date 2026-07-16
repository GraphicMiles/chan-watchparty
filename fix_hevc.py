import re

with open('api/proxy.js', 'r') as f:
    content = f.read()

# Find and replace the HEVC rejection block
old_block = """        const isHevc = videoCodec && /HEVC|H\\.265|V_MPEGH/i.test(videoCodec)
        if (isHevc) {
          await reader.cancel().catch(() => {})
          console.error('Proxy HEVC rejected:', targetUrl.hostname, videoCodec)
          return fail(res, 502, 'This source uses HEVC/H.265 video, which most browsers cannot play. Try a different source or device.')
        }

        // Commit to a 200 MP4 response now that we know the codec is supported."""

new_block = """        const isHevc = videoCodec && /HEVC|H\\.265|V_MPEGH/i.test(videoCodec)
        if (isHevc) {
          console.log('Proxy: HEVC/H.265 MKV detected — passing through for browser to decode', targetUrl.hostname, videoCodec)
        }

        // Commit to a 200 MP4 response now that we know the codec."""

if old_block in content:
    content = content.replace(old_block, new_block)
    with open('api/proxy.js', 'w') as f:
        f.write(content)
    print("Successfully replaced HEVC rejection block")
else:
    print("ERROR: Could not find exact text to replace")
    # Show what's around line 457
    lines = content.split('\n')
    for i in range(454, 465):
        print(f"{i+1}: {lines[i]}")

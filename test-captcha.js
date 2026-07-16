/**
 * Test script for O2TV Captcha Resolver
 * Run: GROQ_API_KEY=your_key node test-captcha.js
 */

import { resolveO2TvEpisodeViaCaptcha } from './server-lib/o2tvCaptchaResolver.js'

async function test() {
  const showSlug = process.argv[2] || 'X-Men-97-otv2cu7b'
  const season = parseInt(process.argv[3] || '1')
  const episode = parseInt(process.argv[4] || '10')

  console.log(`Testing O2TV captcha resolver...`)
  console.log(`Show: ${showSlug}`)
  console.log(`Season: ${season}, Episode: ${episode}`)
  console.log('')

  try {
    const results = await resolveO2TvEpisodeViaCaptcha(showSlug, season, episode)
    
    if (results && results.length > 0) {
      console.log('✅ SUCCESS! CDN URL resolved:')
      console.log(JSON.stringify(results, null, 2))
    } else {
      console.log('❌ No results returned')
    }
  } catch (err) {
    console.error('❌ ERROR:', err.message)
    if (err.message.includes('GROQ_API_KEY')) {
      console.log('\n⚠️  Set GROQ_API_KEY environment variable:')
      console.log('GROQ_API_KEY=your_key node test-captcha.js')
    }
  }
}

test()

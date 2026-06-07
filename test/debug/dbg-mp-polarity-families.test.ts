import { it } from 'vitest'
import { prepareRegionMask } from '@core/ocr/text-recognizer'
import { segmentGlyphs } from '@core/ocr/segmentation'
import { borderMeanLuma, scaleToHeight } from '@core/ocr/imaging'
import { REGION_ALPHABET } from '@core/ocr/types'
import { loadFixtures } from '../helpers/fixtures'

it('tmp: borderLuma distribution + guard-pass family', () => {
  const all = loadFixtures('mp')
  const train = all.filter((_, i) => i % 2 === 0)
  let dark = 0, bright = 0
  for (const f of train) {
    const bl = borderMeanLuma(scaleToHeight(f.image, 48))
    const chars = f.label.split('').filter((c) => REGION_ALPHABET.mp.includes(c))
    const n = segmentGlyphs(prepareRegionMask(f.image, 'mp')).length
    const pass = n === chars.length
    if (bl > 128) dark++; else bright++
    if (pass || bl <= 128) console.log(`${pass ? 'PASS' : 'skip'} bl=${bl.toFixed(0)} pol=${bl > 128 ? 'darkText' : 'brightText'} glyphs=${n}/${chars.length} ${f.name}`)
  }
  console.log(`train=${train.length}: borderLuma>128(darkText extraction)=${dark}, <=128(brightText)=${bright}`)
})

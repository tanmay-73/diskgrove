import { expect, it } from 'vitest'
import { formatCount, formatNumber } from '@shared/format'

it('uses the singular noun only for exactly one', () => {
  expect(formatCount(1, 'file')).toBe('1 file')
  expect(formatCount(0, 'file')).toBe('0 files')
  expect(formatCount(2, 'group')).toBe('2 groups')
  expect(formatCount(1024, 'file')).toBe(`${formatNumber(1024)} files`)
})

it('accepts an irregular plural', () => {
  expect(formatCount(1, 'copy', 'copies')).toBe('1 copy')
  expect(formatCount(3, 'copy', 'copies')).toBe('3 copies')
})

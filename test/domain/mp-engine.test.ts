import { describe, it, expect } from 'vitest'
import * as E from '@core/domain/mp-engine'

/**
 * Behaviour-preservation suite carried over verbatim from the proven v2.x
 * engine.test.js. Any divergence here means the renewal changed game math.
 */

describe('WIS base tick recovery', () => {
  it.each([
    [10, 1],
    [14, 1],
    [15, 2],
    [16, 2],
    [17, 3],
    [18, 3],
    [20, 4],
    [25, 7]
  ])('WIS %i -> %i', (wis, expected) => {
    expect(E.calculateBaseTickRecovery(wis)).toBe(expected)
  })
})

describe('blue potion bonus', () => {
  it.each([
    [10, 1],
    [15, 5],
    [18, 8],
    [25, 15]
  ])('WIS %i -> %i', (wis, expected) => {
    expect(E.calculateBluePotionBonus(wis)).toBe(expected)
  })
})

describe('location bonus', () => {
  it('field -> 0', () => expect(E.calculateLocationBonus('field')).toBe(0))
  it('tavern -> 2', () => expect(E.calculateLocationBonus('tavern')).toBe(2))
  it('dungeon -> -3', () => expect(E.calculateLocationBonus('dungeon')).toBe(-3))
  it('custom +5', () => expect(E.calculateLocationBonus('custom', 5)).toBe(5))
  it('custom -3', () => expect(E.calculateLocationBonus('custom', -3)).toBe(-3))
  it('custom clamps to 50', () => expect(E.calculateLocationBonus('custom', 999)).toBe(50))
})

describe('tick interval', () => {
  it('standing -> 16s', () => expect(E.calculateTickInterval('standing')).toBe(16))
  it('moving -> 32s', () => expect(E.calculateTickInterval('moving')).toBe(32))
  it('combat -> 64s', () => expect(E.calculateTickInterval('combat')).toBe(64))
})

describe('total tick recovery', () => {
  it('WIS15 field no-buff -> 2', () => {
    expect(
      E.calculateTickRecovery({
        wis: 15,
        useBluePotion: false,
        useMeditation: false,
        location: 'field',
        state: 'standing'
      })
    ).toBe(2)
  })
  it('WIS15 + potion -> 7', () => {
    expect(
      E.calculateTickRecovery({
        wis: 15,
        useBluePotion: true,
        useMeditation: false,
        location: 'field',
        state: 'standing'
      })
    ).toBe(7)
  })
  it('WIS15 + potion + meditation + tavern -> 14', () => {
    expect(
      E.calculateTickRecovery({
        wis: 15,
        useBluePotion: true,
        useMeditation: true,
        location: 'tavern',
        state: 'standing'
      })
    ).toBe(14)
  })
  it('meditation inactive while moving -> 9', () => {
    expect(
      E.calculateTickRecovery({
        wis: 15,
        useBluePotion: true,
        useMeditation: true,
        location: 'tavern',
        state: 'moving'
      })
    ).toBe(9)
  })
  it('blocked -> 0', () => {
    expect(E.calculateTickRecovery({ state: 'blocked' })).toBe(0)
  })
  it('dungeon penalty floored at 1', () => {
    expect(
      E.calculateTickRecovery({
        wis: 10,
        useBluePotion: false,
        useMeditation: false,
        location: 'dungeon',
        state: 'standing'
      })
    ).toBe(1)
  })
})

describe('full MP time', () => {
  it('50/327 WIS15 potion+med+tavern -> 320s', () => {
    expect(
      E.calculateFullMpTime(50, 327, {
        wis: 15,
        useBluePotion: true,
        useMeditation: true,
        location: 'tavern',
        state: 'standing'
      })
    ).toBe(320)
  })
  it('already full -> 0', () => {
    expect(E.calculateFullMpTime(327, 327, {})).toBe(0)
  })
  it('blocked -> Infinity', () => {
    expect(E.calculateFullMpTime(0, 327, { state: 'blocked' })).toBe(Infinity)
  })
  it('combat tick x4 -> 512s', () => {
    expect(
      E.calculateFullMpTime(0, 16, {
        wis: 15,
        useBluePotion: false,
        useMeditation: false,
        location: 'field',
        state: 'combat'
      })
    ).toBe(512)
  })
})

describe('formatting', () => {
  it('0 -> 00:00:00', () => expect(E.formatDuration(0)).toBe('00:00:00'))
  it('61 -> 00:01:01', () => expect(E.formatDuration(61)).toBe('00:01:01'))
  it('3661 -> 01:01:01', () => expect(E.formatDuration(3661)).toBe('01:01:01'))
  it('Infinity -> ∞', () => expect(E.formatDuration(Infinity)).toBe('∞'))
})

describe('breakdown', () => {
  it('total matches calculateTickRecovery', () => {
    const cfg = {
      wis: 18,
      useBluePotion: true,
      useMeditation: true,
      location: 'tavern' as const,
      state: 'standing' as const
    }
    const bd = E.breakdown(cfg)
    expect(bd.total).toBe(E.calculateTickRecovery(cfg))
    expect(bd.interval).toBe(16)
  })
})

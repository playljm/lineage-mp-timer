/**
 * MP 회복 엔진 단위 테스트 (순수 Node, 외부 의존성 없음)
 * 실행: npm test
 */
const assert = require('node:assert/strict');
const E = require('../src/js/engine.js');

let pass = 0;
let fail = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail += 1;
    failures.push({ name, err });
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

console.log('\n[1] WIS 기본 회복량');
t('WIS 10 → 1', () => assert.equal(E.calculateBaseTickRecovery(10), 1));
t('WIS 14 → 1', () => assert.equal(E.calculateBaseTickRecovery(14), 1));
t('WIS 15 → 2', () => assert.equal(E.calculateBaseTickRecovery(15), 2));
t('WIS 16 → 2', () => assert.equal(E.calculateBaseTickRecovery(16), 2));
t('WIS 17 → 3', () => assert.equal(E.calculateBaseTickRecovery(17), 3));
t('WIS 18 → 3', () => assert.equal(E.calculateBaseTickRecovery(18), 3));
t('WIS 20 → 4', () => assert.equal(E.calculateBaseTickRecovery(20), 4));
t('WIS 25 → 7', () => assert.equal(E.calculateBaseTickRecovery(25), 7));

console.log('\n[2] 파란물약 추가 회복');
t('WIS 10 → 최소 1', () => assert.equal(E.calculateBluePotionBonus(10), 1));
t('WIS 15 → 5', () => assert.equal(E.calculateBluePotionBonus(15), 5));
t('WIS 18 → 8', () => assert.equal(E.calculateBluePotionBonus(18), 8));
t('WIS 25 → 15', () => assert.equal(E.calculateBluePotionBonus(25), 15));

console.log('\n[3] 위치 보너스');
t('field → 0', () => assert.equal(E.calculateLocationBonus('field'), 0));
t('tavern → 2', () => assert.equal(E.calculateLocationBonus('tavern'), 2));
t('agate → 2', () => assert.equal(E.calculateLocationBonus('agate'), 2));
t('singing → 3', () => assert.equal(E.calculateLocationBonus('singing'), 3));
t('hidden_valley → 3', () => assert.equal(E.calculateLocationBonus('hidden_valley'), 3));
t('dungeon → -3', () => assert.equal(E.calculateLocationBonus('dungeon'), -3));

console.log('\n[4] 틱 주기');
t('standing → 16s', () => assert.equal(E.calculateTickInterval('standing'), 16));
t('moving → 32s', () => assert.equal(E.calculateTickInterval('moving'), 32));
t('combat → 64s', () => assert.equal(E.calculateTickInterval('combat'), 64));

console.log('\n[5] 틱당 총 회복량');
t('기본 WIS15 필드 무버프 → 2', () => {
  const r = E.calculateTickRecovery({
    wis: 15, useBluePotion: false, useMeditation: false,
    location: 'field', state: 'standing'
  });
  assert.equal(r, 2);
});
t('WIS15 + 파란물약 → 2+5=7', () => {
  const r = E.calculateTickRecovery({
    wis: 15, useBluePotion: true, useMeditation: false,
    location: 'field', state: 'standing'
  });
  assert.equal(r, 7);
});
t('WIS15 + 파란물약 + 메디 + 여관 → 2+5+5+2=14', () => {
  const r = E.calculateTickRecovery({
    wis: 15, useBluePotion: true, useMeditation: true,
    location: 'tavern', state: 'standing'
  });
  assert.equal(r, 14);
});
t('메디는 이동 중 비활성 → 2+5+2=9', () => {
  const r = E.calculateTickRecovery({
    wis: 15, useBluePotion: true, useMeditation: true,
    location: 'tavern', state: 'moving'
  });
  assert.equal(r, 9);
});
t('blocked → 0', () => {
  const r = E.calculateTickRecovery({ state: 'blocked' });
  assert.equal(r, 0);
});
t('던전 페널티로 음수 가능 → 최소 1 보장', () => {
  const r = E.calculateTickRecovery({
    wis: 10, useBluePotion: false, useMeditation: false,
    location: 'dungeon', state: 'standing'
  });
  assert.equal(r, 1);
});

console.log('\n[6] 완충 시간 계산');
t('예시: 50/327 WIS15 파란+메디+여관 → 14/틱, 16s', () => {
  const t = E.calculateFullMpTime(50, 327, {
    wis: 15, useBluePotion: true, useMeditation: true,
    location: 'tavern', state: 'standing'
  });
  // 필요 277 / 14 = 20틱 → 320초
  assert.equal(t, 320);
});
t('이미 가득참 → 0', () => {
  const t = E.calculateFullMpTime(327, 327, {});
  assert.equal(t, 0);
});
t('blocked → Infinity', () => {
  const t = E.calculateFullMpTime(0, 327, { state: 'blocked' });
  assert.equal(t, Infinity);
});
t('전투 중 틱 주기 x4', () => {
  const t = E.calculateFullMpTime(0, 16, {
    wis: 15, useBluePotion: false, useMeditation: false,
    location: 'field', state: 'combat'
  });
  // 16/2 = 8틱 * 64s = 512s
  assert.equal(t, 512);
});

console.log('\n[7] 포맷팅');
t('0 → 00:00:00', () => assert.equal(E.formatDuration(0), '00:00:00'));
t('61 → 00:01:01', () => assert.equal(E.formatDuration(61), '00:01:01'));
t('3661 → 01:01:01', () => assert.equal(E.formatDuration(3661), '01:01:01'));
t('Infinity → ∞', () => assert.equal(E.formatDuration(Infinity), '∞'));

console.log('\n[8] breakdown');
t('breakdown 총합 일치', () => {
  const cfg = {
    wis: 18, useBluePotion: true, useMeditation: true,
    location: 'tavern', state: 'standing'
  };
  const bd = E.breakdown(cfg);
  const calc = E.calculateTickRecovery(cfg);
  assert.equal(bd.total, calc);
  assert.equal(bd.interval, 16);
});

console.log(`\n총 ${pass + fail}개: 성공 ${pass}, 실패 ${fail}`);
if (fail > 0) {
  failures.forEach(({ name, err }) => {
    console.error(`FAIL: ${name}\n${err.stack || err.message}`);
  });
  process.exit(1);
}

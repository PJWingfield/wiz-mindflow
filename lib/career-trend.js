'use strict';
// Wellbeing-pulse trend. Scale direction (fixed, and the opposite of the source reconciliation's wording):
//   stress 1-10: HIGHER = more stressed / overwhelmed = WORSE.   energy 1-10: HIGHER = more energetic = BETTER.
// So worsening stress is a RISING stress score. Pure function: no medical inference, no diagnosis.
const DIRECTION_NOTE = 'Higher stress means more stressed or overwhelmed (worse); higher energy means more energetic (better).';
const WINDOW = 3; // the most recent observations compared (two consecutive steps)

function series(values, higherIsWorse) {
  if (values.length < WINDOW) return { direction: 'insufficient_data', values };
  const w = values.slice(-WINDOW); // chronological, oldest first
  const rising = w[1] > w[0] && w[2] > w[1];
  const falling = w[1] < w[0] && w[2] < w[1];
  let direction = 'stable';
  if (rising) direction = higherIsWorse ? 'worsening' : 'improving';
  else if (falling) direction = higherIsWorse ? 'improving' : 'worsening';
  return { direction, values: w };
}

// items: pulse records in any order; each { observed_at, stress, energy }
function pulseTrend(items) {
  const chrono = [...items].sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at) || String(a.id).localeCompare(String(b.id)));
  const stress = series(chrono.map(p => p.stress), true);
  const energy = series(chrono.map(p => p.energy), false);
  return {
    observations: chrono.length,
    window: WINDOW,
    scale: DIRECTION_NOTE,
    stress,
    energy,
    gentle_check_in_suggested: stress.direction === 'worsening' || energy.direction === 'worsening'
  };
}

module.exports = { pulseTrend, DIRECTION_NOTE, WINDOW };

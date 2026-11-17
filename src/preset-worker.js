// Runs the dyno preset search (several seconds per setup) off the panel's main thread.
import * as ops from './ops.js';

self.onmessage = (e) => {
  const { id, kind = 'preset', career, garage, slot, setup, db } = e.data;
  try {
    const game = ops.hydrateDb(db);
    if (kind === 'preset') {
      const r = ops.applyPreset({ career, garage }, slot, setup, game);
      self.postMessage({ id, ok: true, career: r.state.career, garage: r.state.garage, before: r.before, after: r.after, tuningChanged: r.tuningChanged, partsKept: r.partsKept, source: r.source });
      return;
    }
    const r = kind === 'best'
      ? (({ state, report }) => ({ state, reports: [report] }))(ops.bestCar({ career, garage }, slot, game))
      : ops.bestGarage({ career, garage }, game, (i, total) => self.postMessage({ id, progress: { done: i, total } }));
    self.postMessage({ id, ok: true, career: r.state.career, garage: r.state.garage, reports: r.reports });
  } catch (err) {
    self.postMessage({ id, ok: false, why: String(err && err.message || err) });
  }
};

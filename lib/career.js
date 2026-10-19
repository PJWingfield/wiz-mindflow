'use strict';
// Career Development routes (mounted by lib/app.js under /api/v1). Everything is owner-scoped by the VERIFIED bearer user:
// no request field names an owner. Writes need the career_records storage consent (enforced in SQL; a grant is never
// recorded implicitly). Coaching reuse is a separate, explicit per-profile/per-item choice (see the */ai-use routes).
//   GET  /career/content                    credential-free content (worked examples, research steps, questions)
//   GET  /career/research                   six research steps merged with the person's training progress
//   GET|PUT|DELETE /career-plan             singleton plan with route comparison      PUT /career-plan/ai-use
//   GET|PUT|DELETE /learning-profile        private learning profile                  PUT /learning-profile/ai-use
//   collections /portfolio /prior-learning /networking /support-map /pulses: GET list, POST create, GET|PATCH|DELETE :id
//   POST /prior-learning/:id/promote        idempotent promotion into the portfolio
//   GET  /pulses/trend                      direction of recent observations           PUT /portfolio/:id/ai-use, /pulses/:id/ai-use
//   attachments: POST|GET /portfolio/:id/attachments, GET|DELETE /attachments/:id, PUT|GET /attachments/:id/content, POST /attachments/:id/finalize
const express = require('express');
const { e } = require('./errors');
const V = require('./validate');
const { content, researchSteps } = require('./career-content');
const { pulseTrend } = require('./career-trend');
const { ALLOWED_MIME, MAX_BYTES } = require('./attachments');

const ENTRY_TYPES = ['reference', 'work_experience', 'qualification', 'project', 'feedback', 'prior_learning', 'other'];
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

const list = (item, max) => (v, f) => {
  if (!Array.isArray(v) || v.length > max) throw e.invalid(`${f} must be a list of at most ${max} items.`, [f]);
  return v.map(x => item(x, f));
};
const isoTimestamp = (v, f) => {
  if (typeof v !== 'string' || !ISO_RE.test(v) || Number.isNaN(Date.parse(v))) throw e.invalid(`${f} must be an ISO 8601 timestamp with a timezone.`, [f]);
  return v;
};
const optText = max => V.text(0, max, { nullable: true });

const routeSpec = {
  id: V.pattern(SLUG_RE, 40), label: V.text(1, 120), appeal: optText(1000), concerns: optText(1000), funding: optText(1000), next_step: optText(1000)
};
const planSpec = {
  direction: optText(1000),
  values: list(V.text(1, 120), 12),
  competencies: list(V.text(1, 120), 12),
  habits: list(V.text(1, 120), 12),
  readiness: optText(1000),
  goal_ids: list(V.uuid, 10),
  portfolio_ids: list(V.uuid, 20),
  routes: (v, f) => {
    const routes = list((r, g) => V.parse(V.obj(r, g), routeSpec, ['id', 'label']), 8)(v, f);
    if (new Set(routes.map(r => r.id)).size !== routes.length) throw e.invalid('Route ids must be unique.', [f]);
    return routes;
  }
};
const learningSpec = {
  learning_styles: list(V.text(1, 60), 8),
  focus_notes: optText(1000),
  useful_adjustments: optText(1000),
  self_recognition: optText(1500) // private self-recognition notes: never a diagnosis, never used in coaching, never shared
};

const date = V.date;
const nullDate = V.nullable(V.date);
const COLLECTIONS = {
  portfolio: {
    path: '/portfolio', required: ['entry_type', 'title', 'body'], bodyLimit: '16kb',
    spec: { entry_type: V.oneOf(ENTRY_TYPES), title: V.text(1, 200), body: V.text(1, 5000), entry_date: date, goal_id: V.nullable(V.uuid), competencies: list(V.text(1, 80), 10), habits: list(V.text(1, 80), 10) }
  },
  prior_learning: {
    path: '/prior-learning', required: ['experience', 'skill', 'application'], bodyLimit: '8kb',
    spec: { experience: V.text(1, 500), skill: V.text(1, 500), application: V.text(1, 500), recorded_on: date }
  },
  networking: {
    path: '/networking', required: ['contact_label'], bodyLimit: '8kb',
    spec: { contact_label: V.text(1, 200), interaction_date: date, note: optText(2000), follow_up_date: nullDate }
  },
  support: {
    path: '/support-map', required: ['label', 'support_role'], bodyLimit: '8kb',
    spec: { label: V.text(1, 200), support_role: V.text(1, 300), direction: V.nullable(V.oneOf(['supports', 'makes_harder'])), note: optText(2000), last_contact_date: nullDate, next_contact_date: nullDate }
  },
  pulse: {
    path: '/pulses', required: ['stress', 'energy'], bodyLimit: '4kb',
    spec: { stress: V.int(1, 10), energy: V.int(1, 10), note: optText(500), observed_at: isoTimestamp }
  }
};

function mount({ v1, route, secure, json, wrap, body, store, attachments, now = Date.now }) {
  const id = (req, name = 'id') => V.uuid(req.params[name], name);
  const expected = V.int(1, 1e9);
  const requireNonEmpty = o => { if (!Object.keys(o).length) throw e.invalid('Nothing to update.'); };
  const aiUseBody = req => V.parse(body(req), { enabled: V.bool }, ['enabled']).enabled;
  const itemOf = item => ({ item });
  const futureCheck = (req, b, field) => {
    if (b[field] && Date.parse(b[field]) > now() + 60000) throw e.invalid(`${field} cannot be in the future.`, [field]);
  };

  // ---- content (credential-free; Jon's source, held in code) ----
  route(v1, '/career/content', { GET: [(req, res) => { res.setHeader('Cache-Control', 'public, max-age=300'); res.json(content); }] });
  route(v1, '/career/research', {
    GET: [...secure, wrap(async (req, res) => {
      const progress = new Map(((await store.listTraining(req.user.id)) || []).map(t => [t.module_key, t]));
      res.json({
        steps: researchSteps.map(s => { const p = progress.get(s.module_key); return { ...s, status: p ? p.status : 'not_started', percent: p ? p.percent : 0 }; }),
        where_to_look: content.research.where_to_look,
        interview_questions: content.research.interview_questions,
        progress_endpoint: 'PUT /api/v1/training/{module_key}'
      });
    })]
  });

  // ---- career plan (singleton) ----
  route(v1, '/career-plan', {
    GET: [...secure, wrap(async (req, res) => res.json(await store.careerPlanGet(req.user.id)))],
    PUT: [...secure, ...json('48kb'), wrap(async (req, res) => {
      const b = V.parse(body(req), { plan: (v, f) => V.parse(V.obj(v, f), planSpec), expected_version: V.int(0, 1e9) }, ['plan']);
      res.json(await store.careerPlanPut(req.user.id, b.plan, b.expected_version === undefined ? null : b.expected_version));
    })],
    DELETE: [...secure, wrap(async (req, res) => res.json(await store.careerPlanDelete(req.user.id)))]
  });
  route(v1, '/career-plan/ai-use', {
    PUT: [...secure, ...json('1kb'), wrap(async (req, res) => res.json(await store.careerPlanSetAiUse(req.user.id, aiUseBody(req))))]
  });

  // ---- private learning profile ----
  route(v1, '/learning-profile', {
    GET: [...secure, wrap(async (req, res) => res.json(await store.learningGet(req.user.id)))],
    PUT: [...secure, ...json('16kb'), wrap(async (req, res) => {
      const b = V.parse(body(req), { profile: (v, f) => V.parse(V.obj(v, f), learningSpec), expected_version: V.int(0, 1e9) }, ['profile']);
      res.json(await store.learningPut(req.user.id, b.profile, b.expected_version === undefined ? null : b.expected_version));
    })],
    DELETE: [...secure, wrap(async (req, res) => res.json(await store.learningDelete(req.user.id)))]
  });
  route(v1, '/learning-profile/ai-use', {
    PUT: [...secure, ...json('1kb'), wrap(async (req, res) => res.json(await store.learningSetAiUse(req.user.id, aiUseBody(req))))]
  });

  // ---- the five record collections ----
  for (const [kind, c] of Object.entries(COLLECTIONS)) {
    // /pulses/trend must be registered before /pulses/:id
    if (kind === 'pulse') {
      route(v1, '/pulses/trend', {
        GET: [...secure, wrap(async (req, res) => {
          const r = await store.careerList(req.user.id, 'pulse', null, 6);
          res.json({ trend: pulseTrend(r.items), items: r.items });
        })]
      });
    }
    route(v1, c.path, {
      GET: [...secure, wrap(async (req, res) => {
        const r = await store.careerList(req.user.id, kind, V.decodeCursor(req), V.pageLimit(req));
        res.json({ items: r.items, next_cursor: V.encodeCursor(r.next) });
      })],
      POST: [...secure, ...json(c.bodyLimit), wrap(async (req, res) => {
        const b = V.parse(body(req), c.spec, c.required);
        futureCheck(req, b, 'observed_at');
        const r = await store.careerCreate(req.user.id, kind, b, V.idempotencyKey(req));
        res.status(r.replayed ? 200 : 201).json({ item: r.item });
      })]
    });
    const verbs = {
      GET: [...secure, wrap(async (req, res) => res.json(itemOf(await store.careerGet(req.user.id, kind, id(req)))))],
      PATCH: [...secure, ...json(c.bodyLimit), wrap(async (req, res) => {
        const b = V.parse(body(req), { ...c.spec, expected_version: expected }, ['expected_version']);
        const { expected_version: ev, ...patch } = b;
        requireNonEmpty(patch);
        futureCheck(req, patch, 'observed_at');
        res.json(itemOf(await store.careerUpdate(req.user.id, kind, id(req), patch, ev)));
      })],
      DELETE: [...secure, wrap(async (req, res) => {
        const rid = id(req);
        if (kind === 'portfolio') {
          // object bytes go first; any failure stops here with the entry intact and the failed attachment flagged
          for (const a of await store.attachmentList(req.user.id, rid)) await attachments.remove(req.user.id, a.id);
        }
        res.json(await store.careerDelete(req.user.id, kind, rid));
      })]
    };
    route(v1, `${c.path}/:id`, verbs);
  }

  route(v1, '/prior-learning/:id/promote', {
    POST: [...secure, wrap(async (req, res) => {
      const r = await store.priorLearningPromote(req.user.id, id(req), V.idempotencyKey(req));
      res.status(r.replayed ? 200 : 201).json({ item: r.item });
    })]
  });
  route(v1, '/portfolio/:id/ai-use', {
    PUT: [...secure, ...json('1kb'), wrap(async (req, res) => res.json(itemOf(await store.portfolioSetAiUse(req.user.id, id(req), aiUseBody(req)))))]
  });
  route(v1, '/pulses/:id/ai-use', {
    PUT: [...secure, ...json('1kb'), wrap(async (req, res) => res.json(itemOf(await store.pulseSetAiUse(req.user.id, id(req), aiUseBody(req)))))]
  });

  // ---- attachments ----
  const intentSpec = { filename: V.text(1, 200, { blobCheck: false }), mime_type: V.oneOf(ALLOWED_MIME), size: V.int(1, MAX_BYTES) };
  route(v1, '/portfolio/:id/attachments', {
    GET: [...secure, wrap(async (req, res) => res.json({ items: await attachments.list(req.user.id, id(req)) }))],
    POST: [...secure, ...json('2kb'), wrap(async (req, res) => {
      const b = V.parse(body(req), intentSpec, ['filename', 'mime_type', 'size']);
      const r = await attachments.createIntent(req.user.id, id(req), b, V.idempotencyKey(req));
      res.status(r.replayed ? 200 : 201).json({ item: r.item, limits: attachments.limits });
    })]
  });
  route(v1, '/attachments/:id', {
    GET: [...secure, wrap(async (req, res) => res.json(itemOf(await attachments.get(req.user.id, id(req)))))],
    DELETE: [...secure, wrap(async (req, res) => res.json(await attachments.remove(req.user.id, id(req))))]
  });
  route(v1, '/attachments/:id/content', {
    PUT: [...secure, express.raw({ type: () => true, limit: MAX_BYTES }), wrap(async (req, res) => {
      res.json(itemOf(await attachments.upload(req.user.id, id(req), req.body, req.get('content-type'))));
    })],
    GET: [...secure, wrap(async (req, res) => {
      const f = await attachments.download(req.user.id, id(req));
      const ascii = f.filename.replace(/[^\x20-\x7e]/g, '_');
      res.set({
        'Content-Type': f.mime,
        'Content-Length': String(f.buffer.length),
        'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store'
      });
      res.end(f.buffer);
    })]
  });
  route(v1, '/attachments/:id/finalize', {
    POST: [...secure, wrap(async (req, res) => res.json(itemOf(await attachments.finalise(req.user.id, id(req)))))]
  });
}

module.exports = { mount, ENTRY_TYPES };

'use strict';
// Credential-free career content derived from Jon's panel copy (3A.9 worked examples; 3A.10 six-step research
// walkthrough, resources and interview questions). Kept in code, not retrieved from the knowledge base. The full
// human-delivered MFI assessments are deliberately NOT here; WIZ stays a taster.
const RESEARCH_STEP_PREFIX = 'career_research_step_';

const researchSteps = [
  { n: 1, title: 'Widen the net', text: "Explore broadly before narrowing. Don't rule things out too early." },
  { n: 2, title: 'Narrow using what you know about yourself', text: 'Use your Career Profile Blend, values and learning style.' },
  { n: 3, title: 'Talk to people doing it', text: 'A 20-minute conversation beats any brochure.' },
  { n: 4, title: 'Get first-hand exposure', text: 'Work shadowing, taster days, volunteering, short courses.' },
  { n: 5, title: 'Check the practical reality', text: 'Entry routes, qualifications needed, typical pay, demand locally.' },
  { n: 6, title: 'Test small before committing big', text: 'A taster day tells you more than a prospectus.' }
].map(s => ({ ...s, module_key: RESEARCH_STEP_PREFIX + s.n }));

const content = {
  version: 1,
  source: 'Mind Flow career panels 3A.6-3A.10 (reconciled to five new panels)',
  note: 'WIZ is a taster. Full one-to-one assessments are delivered by a human Mind Flow coach.',
  panels: [
    { key: 'evidence_vault', title: 'Evidence Vault (Portfolio Log)', collection: '/portfolio' },
    { key: 'networking_support', title: 'Networking & Support Log', collections: ['/networking', '/support-map'] },
    { key: 'wellbeing_pulse', title: 'Wellbeing Pulse (Plan of Action)', collection: '/pulses' },
    { key: 'prior_learning', title: 'Turning Prior Learning Into Career-Ready Skills', collection: '/prior-learning' },
    { key: 'career_research', title: 'How to Research a Career: Guided Steps', endpoint: '/career/research' }
  ],
  portfolio_entry_types: [
    { value: 'reference', label: 'Reference' },
    { value: 'work_experience', label: 'Work experience / placement / apprenticeship task' },
    { value: 'qualification', label: 'Qualification or course' },
    { value: 'project', label: 'Task or project completed' },
    { value: 'feedback', label: 'Feedback received' },
    { value: 'prior_learning', label: 'Promoted from prior learning' },
    { value: 'other', label: 'Other' }
  ],
  route_chips: ['University', 'Apprenticeship', 'Direct entry', 'Self-employment', 'Armed/uniformed services', 'Further training', 'Exploring'],
  wellbeing_scale: {
    stress: { min: 1, max: 10, higher_is: 'worse', label: 'How stressed or overwhelmed are you feeling about all this right now?' },
    energy: { min: 1, max: 10, higher_is: 'better', label: 'How is your energy?' }
  },
  prior_learning: {
    intro: 'Stepping away from education is never a gap; it is a starting inventory. Read these first, then try your own.',
    worked_examples: [
      { experience: 'English / essay writing', skill: 'Clear written communication, structuring an argument', application: 'Reports, emails, customer communication' },
      { experience: 'Team sport or Duke of Edinburgh', skill: 'Resilience, goal-setting, working under pressure', application: 'Any role requiring reliability and teamwork' },
      { experience: 'Part-time job (retail, hospitality)', skill: 'Customer service, handling money, time-keeping', application: 'Any customer-facing or accountable role' }
    ],
    prompt: 'Now think of your own: school, college, a job, a hobby, a responsibility at home. What subject or experience, what did it actually build in you, and where could you use that at work?',
    columns: ['experience', 'skill', 'application']
  },
  research: {
    steps: researchSteps,
    where_to_look: [
      'National careers service / government careers guidance websites',
      'Professional body and trade association websites for the field',
      'LinkedIn and industry groups',
      'Apprenticeship and vocational training directories',
      'Careers fairs and employer insight days',
      'Labour market information: job demand and typical salaries locally',
      'People already doing the job: informational interviews'
    ],
    interview_questions: [
      'What does a typical day or week actually look like?',
      'What do you wish someone had told you before you started?',
      "What's the route in now, and has it changed recently?",
      "What don't people see from the outside?"
    ]
  }
};

module.exports = { content, researchSteps, RESEARCH_STEP_PREFIX };

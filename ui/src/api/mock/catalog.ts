// Fixture vocabulary for the mock layer. Invented companies on .example hosts.

export interface CatalogSkill {
  id: string;
  name: string;
  category: string;
  quotes: [string, string, string];
}

export const CATEGORIES = ['Product craft', 'AI and ML', 'Data and metrics', 'Engineering depth', 'Leadership', 'Go to market'] as const;

export const SKILLS: CatalogSkill[] = [
  {
    id: 'product-discovery',
    name: 'Product discovery',
    category: 'Product craft',
    quotes: [
      'Run discovery with customers and turn what you learn into clear problem statements',
      'Lead continuous discovery: weekly customer conversations, opportunity mapping and quick prototypes',
      'Validate problems before building, using interviews, prototypes and small tests',
    ],
  },
  {
    id: 'prd-writing',
    name: 'Writing specs',
    category: 'Product craft',
    quotes: [
      'Write crisp product specs that engineers and designers can build from',
      'Turn ambiguous problems into written PRDs with clear scope, risks and success measures',
      'Strong written thinking, especially one-page specs and decision docs',
    ],
  },
  {
    id: 'prioritisation',
    name: 'Prioritisation',
    category: 'Product craft',
    quotes: [
      'Make sharp prioritisation calls and explain the trade-offs to leadership',
      'Own the backlog and rank work by customer impact and effort',
      'Say no to good ideas so the team can ship the important ones',
    ],
  },
  {
    id: 'roadmapping',
    name: 'Roadmapping',
    category: 'Product craft',
    quotes: [
      'Own a quarterly roadmap for the product and keep it tied to company goals',
      'Build and communicate a six-month roadmap across two engineering squads',
      'Set product strategy and a roadmap for a platform used by internal teams',
    ],
  },
  {
    id: 'user-research',
    name: 'User research',
    category: 'Product craft',
    quotes: [
      'Plan and run user research with designers, from interview guides to synthesis',
      'Comfortable running usability tests and turning findings into product changes',
      'Talk to users every week and bring their words back to the team',
    ],
  },
  {
    id: 'llm-integration',
    name: 'LLM product integration',
    category: 'AI and ML',
    quotes: [
      'Ship features built on large language models, from prototype to production',
      'Hands-on experience building with LLM APIs, retrieval and tool use',
      'Understand how retrieval-augmented generation works and where it breaks',
    ],
  },
  {
    id: 'model-evaluation',
    name: 'Model evaluation',
    category: 'AI and ML',
    quotes: [
      'Define evaluation sets and quality bars for model outputs before launch',
      'Set up offline evals and human review loops to measure answer quality',
      'Know how to measure hallucination, latency and cost trade-offs',
    ],
  },
  {
    id: 'prompt-design',
    name: 'Prompt design',
    category: 'AI and ML',
    quotes: [
      'Write and iterate on prompts with engineers, and know when prompting is not enough',
      'Prototype prompt flows yourself to test ideas quickly',
      'Comfortable designing prompts, guardrails and fallbacks for user-facing AI',
    ],
  },
  {
    id: 'ml-fundamentals',
    name: 'ML fundamentals',
    category: 'AI and ML',
    quotes: [
      'Working knowledge of machine learning: training data, features, precision and recall',
      'Understand classification, ranking and embeddings well enough to challenge the ML team',
      'Background in machine learning or data science is a strong plus',
    ],
  },
  {
    id: 'responsible-ai',
    name: 'Responsible AI',
    category: 'AI and ML',
    quotes: [
      'Build with privacy, safety and fairness in mind, and work with legal on AI policy',
      'Own the responsible AI review for features that use customer data',
      'Think clearly about misuse, bias and transparency in AI features',
    ],
  },
  {
    id: 'experimentation',
    name: 'Experimentation',
    category: 'Data and metrics',
    quotes: [
      'Design and read A/B tests with clear hypotheses and guardrail metrics',
      'Run experiments at scale and make calls from the results',
      'Experience with experimentation platforms and statistical significance',
    ],
  },
  {
    id: 'product-metrics',
    name: 'Product metrics',
    category: 'Data and metrics',
    quotes: [
      'Define success metrics and instrument features before they ship',
      'Own the activation and retention metrics for your area',
      'Build dashboards that tell the team whether a launch worked',
    ],
  },
  {
    id: 'sql',
    name: 'SQL',
    category: 'Data and metrics',
    quotes: [
      'Comfortable writing SQL to answer your own questions',
      'Pull and analyse data yourself with SQL and a notebook',
      'Strong SQL; you will not wait on an analyst for basic queries',
    ],
  },
  {
    id: 'data-analysis',
    name: 'Data analysis',
    category: 'Data and metrics',
    quotes: [
      'Find the story in messy usage data and turn it into decisions',
      'Analytical depth: funnels, cohorts and segmentation',
      'Use data to size opportunities before committing a team',
    ],
  },
  {
    id: 'technical-fluency',
    name: 'Technical fluency',
    category: 'Engineering depth',
    quotes: [
      'Engineering background or the ability to go deep on technical design with engineers',
      'Technical enough to read a design doc and spot the risky parts',
      'Former engineers are encouraged to apply',
    ],
  },
  {
    id: 'api-design',
    name: 'API design',
    category: 'Engineering depth',
    quotes: [
      'Own developer-facing APIs and their documentation',
      'Understand API design, versioning and developer experience',
      'Experience shipping platform products or public APIs',
    ],
  },
  {
    id: 'system-design',
    name: 'System design',
    category: 'Engineering depth',
    quotes: [
      'Understand distributed systems well enough to reason about latency, cost and reliability',
      'Work with engineering on architecture choices for model serving and data pipelines',
      'Comfortable with system design conversations about scale and failure modes',
    ],
  },
  {
    id: 'stakeholder-management',
    name: 'Stakeholder management',
    category: 'Leadership',
    quotes: [
      'Align sales, support, legal and engineering around one plan',
      'Manage senior stakeholders and keep them informed without slowing the team',
      'Build trust with leadership through clear, regular updates',
    ],
  },
  {
    id: 'cross-functional',
    name: 'Cross-functional leadership',
    category: 'Leadership',
    quotes: [
      'Lead a cross-functional team of engineers, designers and data scientists',
      'Drive delivery across several teams without direct authority',
      'Bring design, engineering and data together around a shared goal',
    ],
  },
  {
    id: 'written-communication',
    name: 'Written communication',
    category: 'Leadership',
    quotes: [
      'Excellent writing: you explain complex ideas in plain words',
      'Write launch notes, FAQs and updates that people actually read',
      'Clear communicator in writing and in reviews',
    ],
  },
  {
    id: 'go-to-market',
    name: 'Go-to-market',
    category: 'Go to market',
    quotes: [
      'Partner with marketing and sales on launches, positioning and enablement',
      'Own go-to-market for new AI features, from pricing page to sales training',
      'Experience launching B2B products with sales teams',
    ],
  },
  {
    id: 'pricing',
    name: 'Pricing',
    category: 'Go to market',
    quotes: [
      'Work on packaging and pricing for usage-based AI features',
      'Model unit economics, including inference cost per customer',
      'Experience with pricing experiments is a plus',
    ],
  },
];

export type Family = 'AI product' | 'Platform product' | 'Growth product' | 'Technical product' | 'Data product';

export const FAMILY_WEIGHTS: Record<Family, Record<string, number>> = {
  'AI product': {
    'llm-integration': 0.92,
    'model-evaluation': 0.78,
    'prompt-design': 0.6,
    'ml-fundamentals': 0.5,
    'responsible-ai': 0.45,
    'product-discovery': 0.66,
    'prd-writing': 0.55,
    experimentation: 0.55,
    'product-metrics': 0.6,
    'technical-fluency': 0.55,
    'stakeholder-management': 0.45,
    'cross-functional': 0.5,
    roadmapping: 0.42,
    'go-to-market': 0.3,
    pricing: 0.22,
    sql: 0.3,
    'user-research': 0.45,
    'written-communication': 0.35,
    prioritisation: 0.5,
    'data-analysis': 0.3,
    'system-design': 0.25,
    'api-design': 0.15,
  },
  'Platform product': {
    'api-design': 0.82,
    'system-design': 0.7,
    'technical-fluency': 0.8,
    'llm-integration': 0.5,
    roadmapping: 0.62,
    'stakeholder-management': 0.6,
    'prd-writing': 0.5,
    'product-metrics': 0.4,
    'cross-functional': 0.5,
    prioritisation: 0.55,
    'model-evaluation': 0.35,
    'written-communication': 0.45,
    'product-discovery': 0.35,
    'user-research': 0.25,
  },
  'Growth product': {
    experimentation: 0.92,
    'product-metrics': 0.85,
    sql: 0.7,
    'data-analysis': 0.7,
    'user-research': 0.5,
    'product-discovery': 0.55,
    prioritisation: 0.5,
    'go-to-market': 0.4,
    pricing: 0.45,
    'llm-integration': 0.35,
    'cross-functional': 0.4,
    'prd-writing': 0.4,
  },
  'Technical product': {
    'technical-fluency': 0.88,
    'system-design': 0.62,
    'api-design': 0.5,
    'llm-integration': 0.6,
    'model-evaluation': 0.5,
    'ml-fundamentals': 0.5,
    'prd-writing': 0.6,
    prioritisation: 0.5,
    'cross-functional': 0.55,
    'stakeholder-management': 0.45,
    sql: 0.4,
  },
  'Data product': {
    sql: 0.75,
    'data-analysis': 0.7,
    'ml-fundamentals': 0.62,
    'product-metrics': 0.6,
    'model-evaluation': 0.45,
    experimentation: 0.45,
    'stakeholder-management': 0.5,
    roadmapping: 0.4,
    'responsible-ai': 0.35,
    'llm-integration': 0.4,
  },
};

export interface Company {
  name: string;
  host: string;
  size: 'startup' | 'scaleup' | 'enterprise';
  blurb: string;
}

export const COMPANIES: Company[] = [
  { name: 'Kestrel Pay', host: 'kestrelpay.example', size: 'scaleup', blurb: 'builds payment infrastructure for online merchants across India.' },
  { name: 'Tessellate', host: 'tessellate.example', size: 'startup', blurb: 'makes an AI workspace for operations teams.' },
  { name: 'Loomwork', host: 'loomwork.example', size: 'scaleup', blurb: 'runs a marketplace for independent textile makers.' },
  { name: 'Saffron Health', host: 'saffronhealth.example', size: 'scaleup', blurb: 'helps clinics manage appointments, records and billing.' },
  { name: 'Brightline Logistics', host: 'brightline.example', size: 'enterprise', blurb: 'moves freight for 3,000 shippers across South Asia.' },
  { name: 'Quillmark', host: 'quillmark.example', size: 'startup', blurb: 'builds drafting and review tools for legal teams.' },
  { name: 'Monsoon Commerce', host: 'monsoon.example', size: 'enterprise', blurb: 'runs one of the larger online grocery businesses in India.' },
  { name: 'Mintleaf Finance', host: 'mintleaf.example', size: 'scaleup', blurb: 'offers savings and credit products to salaried workers.' },
  { name: 'Orbit Learning', host: 'orbitlearning.example', size: 'scaleup', blurb: 'runs live online courses for working professionals.' },
  { name: 'Parallax Data', host: 'parallaxdata.example', size: 'startup', blurb: 'builds a data catalogue that answers questions in plain language.' },
  { name: 'Juniper Grid', host: 'junipergrid.example', size: 'enterprise', blurb: 'manages energy use for factories and campuses.' },
  { name: 'Ridgeway Systems', host: 'ridgeway.example', size: 'enterprise', blurb: 'sells HR and payroll software to mid-size companies.' },
  { name: 'Ember Analytics', host: 'emberanalytics.example', size: 'startup', blurb: 'turns support conversations into product insight.' },
  { name: 'Stackfield', host: 'stackfield.example', size: 'scaleup', blurb: 'runs a developer platform for deploying internal tools.' },
  { name: 'Polar Assurance', host: 'polarassure.example', size: 'enterprise', blurb: 'sells health and motor insurance online.' },
  { name: 'Arcadia Telecom', host: 'arcadia-telecom.example', size: 'enterprise', blurb: 'serves 40 million mobile subscribers.' },
  { name: 'Redwood Mobility', host: 'redwoodmobility.example', size: 'scaleup', blurb: 'runs a ride and delivery fleet in six cities.' },
  { name: 'Fernhill Bank', host: 'fernhill.example', size: 'enterprise', blurb: 'is a digital-first retail bank.' },
  { name: 'Cinder Labs', host: 'cinderlabs.example', size: 'startup', blurb: 'builds voice agents for customer service teams.' },
  { name: 'Halcyon Travel', host: 'halcyontravel.example', size: 'scaleup', blurb: 'sells holiday packages and corporate travel.' },
  { name: 'Wren Studio', host: 'wrenstudio.example', size: 'startup', blurb: 'makes design tools for small marketing teams.' },
  { name: 'Bayleaf Retail', host: 'bayleaf.example', size: 'enterprise', blurb: 'runs 300 fashion stores and an online shop.' },
  { name: 'Copperline Media', host: 'copperline.example', size: 'scaleup', blurb: 'runs a news and video app in eight languages.' },
];

export const TITLES: Record<Family, string[]> = {
  'AI product': [
    'AI Product Manager',
    'Product Manager, Generative AI',
    'Senior Product Manager, AI Assistant',
    'Associate Product Manager, AI',
    'Product Manager, AI Agents',
    'Lead Product Manager, Applied AI',
  ],
  'Platform product': ['Product Manager, Developer Platform', 'Senior Product Manager, AI Platform', 'Product Manager, Internal Tools', 'Platform Product Manager'],
  'Growth product': ['Product Manager, Growth', 'Senior Product Manager, Activation', 'Growth Product Manager', 'Product Manager, Monetisation'],
  'Technical product': ['Technical Product Manager', 'Technical Product Manager, ML Platform', 'Senior Technical Product Manager, APIs'],
  'Data product': ['Product Manager, Data and Insights', 'Data Product Manager', 'Product Manager, Search and Ranking'],
};

export const MISSIONS: Record<Family, string[]> = {
  'AI product': [
    'shape how our customers use AI inside the product',
    'take our AI assistant from a promising beta to a feature people rely on every day',
    'own the agent features that automate routine work for our customers',
  ],
  'Platform product': [
    'build the platform other product teams use to ship AI features',
    'make our internal developer platform faster and easier to adopt',
  ],
  'Growth product': ['grow activation and retention for new customers', 'own the funnel from sign-up to first value'],
  'Technical product': [
    'lead the technical roadmap for our model serving and APIs',
    'work closely with engineering on the systems behind our AI features',
  ],
  'Data product': ['turn our data into products customers can act on', 'own search and ranking quality across the app'],
};

export const LOCATIONS = [
  'Bengaluru',
  'Bengaluru',
  'Bengaluru',
  'Bengaluru',
  'Bengaluru',
  'Remote, India',
  'Remote, India',
  'Hyderabad',
  'Pune',
  'Mumbai',
  'Gurugram',
];

export const BRIDGES: Record<string, { from: string; note: string }> = {
  'prd-writing': {
    from: 'Design docs',
    note: 'Avery writes design docs for every major change and two became team templates. A PRD is the same habit pointed at the problem instead of the solution.',
  },
  experimentation: {
    from: 'Feature-flag rollouts',
    note: 'The retry-logic rollout already compared cohorts behind a flag. What is missing is framing it as a hypothesis with a guardrail metric and a decision rule.',
  },
  'model-evaluation': {
    from: 'Test design',
    note: 'The graded set of 60 support answers is an eval set in all but name. Scaling it to a rubric with human review is the step postings ask for.',
  },
  'user-research': {
    from: 'Support log analysis',
    note: 'Reading six months of failed-payment logs is research on behaviour. Pairing it with interviews would cover what postings mean by discovery.',
  },
  'product-metrics': {
    from: 'Merchant health report',
    note: 'The weekly merchant health report already tracks outcomes the business reads. Owning activation or retention numbers is a short step from there.',
  },
  'stakeholder-management': {
    from: 'Cross-team reviews',
    note: 'Fortnightly reviews with finance and support are stakeholder work. Postings want the same with sales and legal in the room.',
  },
  'cross-functional': {
    from: 'Five-team launch',
    note: 'The instant-refunds launch coordinated five teams. Leading it as the owner of the outcome, not the engineering lead, is the shift.',
  },
};

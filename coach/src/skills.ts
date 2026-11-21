export interface SkillDef { id: string; name: string; category: string; aliases: string[] }

// Canonical vocabulary. Anything the model names that is not here still gets a stable slug id.
export const CATALOG: SkillDef[] = [
  // product
  { id: 'product-discovery', name: 'Product discovery', category: 'product', aliases: ['discovery', 'problem discovery', 'customer discovery', 'opportunity assessment', 'jobs to be done', 'jtbd', 'problem framing', 'discovery research'] },
  { id: 'user-research', name: 'User research', category: 'product', aliases: ['user interviews', 'customer interviews', 'usability testing', 'ux research', 'customer research', 'user testing', 'talking to users'] },
  { id: 'prd-writing', name: 'PRD writing', category: 'product', aliases: ['prd', 'prds', 'product requirements', 'product requirements documents', 'product requirement documents', 'product specs', 'product specifications', 'spec writing', 'requirements writing', 'writing specs'] },
  { id: 'roadmapping', name: 'Roadmapping', category: 'product', aliases: ['roadmap', 'roadmaps', 'product roadmap', 'roadmap planning', 'roadmap ownership'] },
  { id: 'prioritization', name: 'Prioritisation', category: 'product', aliases: ['prioritisation', 'prioritization frameworks', 'backlog prioritization', 'rice', 'trade-offs', 'tradeoffs', 'trade offs'] },
  { id: 'product-strategy', name: 'Product strategy', category: 'product', aliases: ['strategy', 'product vision', 'vision', 'product thinking', 'product sense'] },
  { id: 'go-to-market', name: 'Go-to-market', category: 'product', aliases: ['gtm', 'go to market', 'launch', 'launches', 'product launches', 'launch planning'] },
  { id: 'pricing', name: 'Pricing and packaging', category: 'product', aliases: ['pricing and packaging', 'packaging', 'monetization', 'monetisation', 'pricing strategy', 'usage-based pricing', 'pricing models'] },
  // ai
  { id: 'llm-fundamentals', name: 'LLM fundamentals', category: 'ai', aliases: ['llm', 'llms', 'large language models', 'generative ai', 'genai', 'gen ai', 'foundation models', 'transformers', 'how llms work'] },
  { id: 'llm-evaluation', name: 'LLM evaluation', category: 'ai', aliases: ['evals', 'eval', 'llm evals', 'model evaluation', 'ai evaluation', 'evaluation frameworks', 'eval design', 'offline evaluation', 'golden datasets', 'evaluation', 'ai quality'] },
  { id: 'prompt-engineering', name: 'Prompt engineering', category: 'ai', aliases: ['prompting', 'prompt design', 'prompts'] },
  { id: 'rag', name: 'Retrieval (RAG)', category: 'ai', aliases: ['retrieval augmented generation', 'retrieval-augmented generation', 'retrieval', 'vector search', 'embeddings', 'semantic search', 'rag pipelines'] },
  { id: 'ai-agents', name: 'AI agents', category: 'ai', aliases: ['agents', 'agentic workflows', 'agentic systems', 'tool calling', 'function calling', 'multi-agent', 'ai agent', 'autonomous agents'] },
  { id: 'ml-fundamentals', name: 'ML fundamentals', category: 'ai', aliases: ['machine learning', 'ml', 'model training', 'ml models', 'data science', 'predictive models'] },
  { id: 'responsible-ai', name: 'Responsible AI', category: 'ai', aliases: ['ai safety', 'ai governance', 'trust and safety', 'model risk', 'guardrails', 'safety', 'ai ethics', 'fairness'] },
  { id: 'ai-cost-latency', name: 'Model cost and latency', category: 'ai', aliases: ['inference cost', 'model cost', 'latency', 'model selection', 'cost optimisation', 'cost optimization', 'ai unit economics'] },
  { id: 'fine-tuning', name: 'Fine-tuning', category: 'ai', aliases: ['finetuning', 'model fine-tuning', 'lora'] },
  // data
  { id: 'sql', name: 'SQL', category: 'data', aliases: ['sql queries', 'postgres', 'postgresql', 'mysql', 'bigquery', 'writing sql'] },
  { id: 'product-analytics', name: 'Product analytics', category: 'data', aliases: ['analytics', 'data analysis', 'dashboards', 'funnel analysis', 'funnels', 'amplitude', 'mixpanel', 'data-driven decision making', 'data driven decision making', 'data fluency'] },
  { id: 'experimentation', name: 'Experimentation', category: 'data', aliases: ['a/b testing', 'ab testing', 'a/b tests', 'a/b test', 'split testing', 'experiment design', 'controlled experiments', 'a/b experiments', 'experiments'] },
  { id: 'metrics-definition', name: 'Metrics and KPIs', category: 'data', aliases: ['kpis', 'metrics', 'success metrics', 'north star metric', 'okrs', 'metric design', 'defining metrics'] },
  { id: 'data-pipelines', name: 'Data pipelines', category: 'data', aliases: ['etl', 'kafka', 'streaming', 'data engineering', 'event pipelines'] },
  // technical
  { id: 'apis', name: 'APIs and integrations', category: 'technical', aliases: ['api', 'apis', 'rest', 'rest apis', 'restful apis', 'api design', 'integrations', 'grpc', 'webhooks', 'sdks', 'api products'] },
  { id: 'system-design', name: 'System design', category: 'technical', aliases: ['architecture', 'distributed systems', 'scalability', 'technical architecture', 'systems design'] },
  { id: 'backend-engineering', name: 'Backend engineering', category: 'technical', aliases: ['backend', 'backend development', 'server-side', 'microservices', 'software engineering', 'go', 'golang', 'java'] },
  { id: 'python', name: 'Python', category: 'technical', aliases: ['python scripting'] },
  { id: 'cloud-infrastructure', name: 'Cloud infrastructure', category: 'technical', aliases: ['aws', 'gcp', 'azure', 'cloud', 'kubernetes', 'docker', 'infrastructure'] },
  { id: 'testing', name: 'Testing and quality', category: 'technical', aliases: ['test automation', 'qa', 'quality assurance', 'unit testing', 'integration testing', 'automated testing'] },
  { id: 'technical-fluency', name: 'Technical fluency', category: 'technical', aliases: ['technical background', 'engineering background', 'technical depth', 'cs fundamentals', 'technical acumen', 'technical understanding'] },
  // collaboration
  { id: 'stakeholder-management', name: 'Stakeholder management', category: 'collaboration', aliases: ['stakeholders', 'stakeholder communication', 'cross-team alignment', 'executive communication', 'stakeholder alignment', 'managing stakeholders'] },
  { id: 'cross-functional-leadership', name: 'Cross-functional leadership', category: 'collaboration', aliases: ['cross-functional collaboration', 'cross functional collaboration', 'influence without authority', 'leading cross-functional teams', 'cross-functional teams', 'working with design and engineering'] },
  { id: 'communication', name: 'Communication', category: 'collaboration', aliases: ['written communication', 'storytelling', 'presentation', 'presentations', 'clear writing', 'verbal communication'] },
  { id: 'technical-writing', name: 'Technical writing', category: 'collaboration', aliases: ['design docs', 'design documents', 'rfcs', 'documentation', 'technical documentation'] },
  { id: 'mentoring', name: 'Mentoring', category: 'collaboration', aliases: ['coaching', 'mentorship', 'people management', 'managing pms'] },
  { id: 'agile-delivery', name: 'Agile delivery', category: 'collaboration', aliases: ['agile', 'scrum', 'sprint planning', 'delivery', 'execution', 'project management', 'program management'] },
  // business
  { id: 'business-acumen', name: 'Business acumen', category: 'business', aliases: ['p&l', 'p and l', 'unit economics', 'business cases', 'commercial awareness', 'business sense'] },
  { id: 'competitive-analysis', name: 'Competitive analysis', category: 'business', aliases: ['market research', 'competitor analysis', 'market analysis', 'competitive landscape'] },
  { id: 'b2b-saas', name: 'B2B SaaS', category: 'business', aliases: ['saas', 'enterprise software', 'enterprise customers', 'b2b'] },
  { id: 'domain-expertise', name: 'Domain expertise', category: 'business', aliases: ['domain knowledge', 'industry knowledge', 'regulatory knowledge', 'compliance'] },
];

// Learn the prerequisite first. Kept acyclic; a test enforces it.
export const PREREQS: Record<string, string[]> = {
  'llm-evaluation': ['llm-fundamentals'],
  'prompt-engineering': ['llm-fundamentals'],
  'rag': ['llm-fundamentals', 'prompt-engineering'],
  'ai-agents': ['prompt-engineering', 'llm-evaluation'],
  'fine-tuning': ['ml-fundamentals', 'llm-evaluation'],
  'responsible-ai': ['llm-fundamentals'],
  'ai-cost-latency': ['llm-fundamentals'],
  'prd-writing': ['product-discovery'],
  'prioritization': ['product-discovery'],
  'product-strategy': ['product-discovery', 'competitive-analysis'],
  'roadmapping': ['prioritization', 'product-strategy'],
  'pricing': ['product-strategy', 'business-acumen'],
  'go-to-market': ['product-strategy'],
  'experimentation': ['product-analytics'],
  'metrics-definition': ['product-analytics'],
  'product-analytics': ['sql'],
  'cross-functional-leadership': ['stakeholder-management'],
};

// A skill the person already has that gives them a head start on another.
export const BRIDGES: Record<string, { from: string[]; note: string }> = {
  'llm-evaluation': { from: ['testing', 'experimentation'], note: 'Test suites, golden cases and pass thresholds are most of an eval harness. The new part is scoring outputs that have no single right answer.' },
  'prd-writing': { from: ['technical-writing'], note: 'Design docs and RFCs already force clear problem statements. A PRD keeps that shape but swaps the how for the who, why and what success looks like.' },
  'product-discovery': { from: ['stakeholder-management'], note: 'Gathering requirements from ops and finance teams is discovery with internal users. The step up is doing it with customers before anything is built.' },
  'user-research': { from: ['stakeholder-management', 'communication'], note: 'Running alignment conversations with other teams is close to running interviews; add a script, open questions and synthesis.' },
  'roadmapping': { from: ['agile-delivery', 'system-design'], note: 'Sequencing engineering work across quarters is half of a roadmap. The other half is choosing the bets and explaining what you are not doing.' },
  'prioritization': { from: ['agile-delivery'], note: 'Sprint and backlog trade-offs transfer directly; product prioritisation adds customer value and business impact to the cost side you already know.' },
  'experimentation': { from: ['sql', 'product-analytics'], note: 'You can already pull and slice experiment data. The gap is design: hypotheses, sample sizes and guardrail metrics.' },
  'product-analytics': { from: ['sql'], note: 'Strong SQL is the hard part of product analytics; what remains is knowing which funnels and cohorts answer a product question.' },
  'metrics-definition': { from: ['sql', 'data-pipelines'], note: 'You know how events are produced and stored, which makes defining trustworthy metrics much easier.' },
  'prompt-engineering': { from: ['apis', 'python'], note: 'Treat a prompt like an API contract: explicit inputs, a strict output schema and tests for edge cases.' },
  'rag': { from: ['backend-engineering', 'data-pipelines', 'system-design'], note: 'Retrieval is an indexing and ranking pipeline; your backend and data pipeline work covers most of the plumbing.' },
  'ai-agents': { from: ['system-design', 'apis'], note: 'Agents are workflows over tools and APIs with failure handling; distributed systems instincts about retries and timeouts carry over.' },
  'ai-cost-latency': { from: ['cloud-infrastructure', 'system-design'], note: 'Capacity planning and cloud cost work map onto token budgets, caching and model routing.' },
  'llm-fundamentals': { from: ['python', 'backend-engineering'], note: 'An engineering background makes the mechanics of tokens, context windows and sampling quick to pick up.' },
  'stakeholder-management': { from: ['communication', 'mentoring'], note: 'Explaining trade-offs to teammates is the same muscle you will use with leadership and sales.' },
  'cross-functional-leadership': { from: ['stakeholder-management', 'mentoring'], note: 'Leading cross-team projects as an engineer is the closest thing to leading as a PM without the title.' },
  'technical-fluency': { from: ['backend-engineering', 'system-design'], note: 'Your engineering years are the technical fluency these roles ask for.' },
  'go-to-market': { from: ['communication'], note: 'Clear written communication is the base of launch plans, release notes and sales enablement.' },
  'responsible-ai': { from: ['testing', 'system-design'], note: 'Thinking about failure modes and safeguards in systems carries over to guardrails and red-teaming.' },
  'business-acumen': { from: ['product-analytics', 'sql'], note: 'Reading the numbers is the first step; tying them to revenue and cost is the next.' },
};

const BY_ID = new Map(CATALOG.map((s) => [s.id, s]));
const ALIASES = new Map<string, string>();
for (const s of CATALOG) {
  ALIASES.set(key(s.id), s.id);
  ALIASES.set(key(s.name), s.id);
  for (const a of s.aliases) ALIASES.set(key(a), s.id);
}
// Single words that are safe to spot inside a longer phrase; generic ones like "vision" are not.
const DISTINCT = new Set(['sql', 'llm', 'llms', 'rag', 'prd', 'prds', 'evals', 'kpis', 'okrs', 'gtm', 'genai', 'embeddings',
  'pricing', 'roadmap', 'roadmaps', 'roadmapping', 'prioritization', 'prioritisation', 'experimentation', 'prompting',
  'python', 'kafka', 'aws', 'gcp', 'azure', 'kubernetes', 'stakeholders', 'monetization', 'monetisation', 'finetuning']);
// Longest first so "llm evaluation frameworks" matches "llm evaluation" rather than "llm".
const CONTAINED = [...ALIASES.keys()].filter((k) => /[ /]/.test(k) || DISTINCT.has(k)).sort((a, b) => b.length - a.length);

function key(name: string): string {
  return name.toLowerCase().replace(/&/g, ' and ').replace(/[-_]+/g, ' ').replace(/[^a-z0-9/+ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function exact(k: string): string | undefined {
  return ALIASES.get(k) ?? (k.endsWith('s') ? ALIASES.get(k.slice(0, -1)) : undefined);
}

function slug(name: string): string {
  return key(name).replace(/[/+]/g, ' ').trim().replace(/\s+/g, '-') || 'skill';
}

function lookup(name: string): string | undefined {
  const k = key(name);
  if (!k) return undefined;
  const hit = exact(k);
  if (hit) return hit;
  // "SQL and Python" or "Roadmaps, OKRs": take the first part we recognise.
  const parts = name.split(/\s+and\s+|[,;(]/i).map(key).filter(Boolean);
  if (parts.length > 1) for (const p of parts) { const h = exact(p); if (h) return h; }
  for (const a of CONTAINED) {
    const i = k.indexOf(a);
    if (i < 0) continue;
    const before = i === 0 || k[i - 1] === ' ';
    const after = i + a.length === k.length || k[i + a.length] === ' ';
    if (before && after) return ALIASES.get(a);
  }
  return undefined;
}

export function skillId(name: string): string {
  return lookup(name) ?? slug(name);
}

const GUESS: [RegExp, string][] = [
  [/\b(llm|ai|ml|model|prompt|agent|rag|genai|nlp|vision|embedding)/, 'ai'],
  [/\b(sql|data|analytic|metric|experiment|statistic|dashboard)/, 'data'],
  [/\b(api|cloud|backend|code|engineering|architecture|python|java|devops|security)/, 'technical'],
  [/\b(stakeholder|team|lead|mentor|communicat|collaborat|writing)/, 'collaboration'],
  [/\b(pricing|market|sales|revenue|business|finance|legal|compliance|domain)/, 'business'],
];

export function canonical(name: string): { id: string; name: string; category: string } {
  const id = lookup(name);
  const def = id ? BY_ID.get(id) : undefined;
  if (def) return { id: def.id, name: def.name, category: def.category };
  const k = key(name);
  const category = GUESS.find(([re]) => re.test(k))?.[1] ?? 'other';
  const pretty = name.trim().replace(/\s+/g, ' ');
  return { id: slug(name), name: pretty.charAt(0).toUpperCase() + pretty.slice(1), category };
}

export function catalogNames(): string[] {
  return CATALOG.map((s) => s.name);
}

const FOLD: Record<string, string> = {
  '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', ' ': ' ', '•': '-',
};

function normalise(s: string): { norm: string; map: number[] } {
  let norm = '';
  const map: number[] = [];
  let space = true;
  for (let i = 0; i < s.length; i++) {
    let c = FOLD[s[i]] ?? s[i];
    if (/\s/.test(c)) {
      if (space) continue;
      c = ' ';
      space = true;
    } else space = false;
    for (const ch of c.toLowerCase()) { norm += ch; map.push(i); }
  }
  return { norm, map };
}

// Returns the exact span of `text` that `quote` refers to, tolerating case, whitespace and
// typographic quote differences, or undefined when the quote is not really in the text.
export function findQuote(text: string, quote: string): string | undefined {
  let q = quote.trim();
  if (/\.\.\.|…/.test(q)) q = q.split(/\.\.\.|…/).map((p) => p.trim()).sort((a, b) => b.length - a.length)[0];
  q = q.replace(/^["'“‘\s-]+|["'”’\s.,;:]+$/g, '');
  const nq = normalise(q).norm.trim();
  if (nq.length < 3) return undefined;
  const { norm, map } = normalise(text);
  const at = norm.indexOf(nq);
  if (at < 0) return undefined;
  return text.slice(map[at], map[at + nq.length - 1] + 1);
}

// Public job boards Tack reads without a browser. Every slug here answered a
// live listing call on 21 Nov 2026; `india` means the board listed roles in India then.

export type Ats = 'greenhouse' | 'lever' | 'ashby' | 'workable';
export type CompanySize = 'startup' | 'scaleup' | 'enterprise';

export interface Board {
  ats: Ats;
  board: string;
  name: string;
  size: CompanySize;
  india: boolean;
}

const b = (ats: Ats, board: string, name: string, size: CompanySize, india: boolean): Board => ({ ats, board, name, size, india });

export const BOARDS: readonly Board[] = [
  // Hiring in India, product and engineering heavy
  b('greenhouse', 'databricks', 'Databricks', 'enterprise', true),
  b('greenhouse', 'okta', 'Okta', 'enterprise', true),
  b('greenhouse', 'gitlab', 'GitLab', 'enterprise', true),
  b('greenhouse', 'zscaler', 'Zscaler', 'enterprise', true),
  b('greenhouse', 'stripe', 'Stripe', 'enterprise', true),
  b('greenhouse', 'rubrik', 'Rubrik', 'enterprise', true),
  b('greenhouse', 'twilio', 'Twilio', 'enterprise', true),
  b('greenhouse', 'datadog', 'Datadog', 'enterprise', true),
  b('greenhouse', 'coinbase', 'Coinbase', 'enterprise', true),
  b('greenhouse', 'airbnb', 'Airbnb', 'enterprise', true),
  b('greenhouse', 'toast', 'Toast', 'enterprise', true),
  b('greenhouse', 'elastic', 'Elastic', 'enterprise', true),
  b('greenhouse', 'mongodb', 'MongoDB', 'enterprise', true),
  b('greenhouse', 'nebius', 'Nebius', 'enterprise', true),
  b('ashby', 'uipath', 'UiPath', 'enterprise', true),
  b('lever', 'paytm', 'Paytm', 'enterprise', true),
  b('greenhouse', 'fivetran', 'Fivetran', 'scaleup', true),
  b('greenhouse', 'gleanwork', 'Glean', 'scaleup', true),
  b('greenhouse', 'highradius', 'HighRadius', 'scaleup', true),
  b('greenhouse', 'sigmoid', 'Sigmoid', 'scaleup', true),
  b('greenhouse', 'hackerrank', 'HackerRank', 'scaleup', true),
  b('greenhouse', 'sumologic', 'Sumo Logic', 'scaleup', true),
  b('greenhouse', 'druva', 'Druva', 'scaleup', true),
  b('greenhouse', 'groww', 'Groww', 'scaleup', true),
  b('greenhouse', 'turing', 'Turing', 'scaleup', true),
  b('greenhouse', 'inmobi', 'InMobi', 'scaleup', true),
  b('greenhouse', 'glance', 'Glance', 'scaleup', true),
  b('greenhouse', 'razorpaysoftwareprivatelimited', 'Razorpay', 'scaleup', true),
  b('greenhouse', 'mixpanel', 'Mixpanel', 'scaleup', true),
  b('lever', 'meesho', 'Meesho', 'scaleup', true),
  b('lever', 'zeta', 'Zeta', 'scaleup', true),
  b('lever', 'cred', 'CRED', 'scaleup', true),
  b('lever', 'mindtickle', 'Mindtickle', 'scaleup', true),
  b('ashby', 'atlan', 'Atlan', 'scaleup', true),
  b('ashby', 'clickhouse', 'ClickHouse', 'scaleup', true),
  b('lever', 'hevodata', 'Hevo Data', 'startup', true),
  b('lever', 'fampay', 'FamPay', 'startup', true),
  b('lever', 'netomi', 'Netomi', 'startup', true),
  b('ashby', 'bureau', 'Bureau', 'startup', true),
  b('greenhouse', 'observeai', 'Observe.AI', 'startup', true),

  // AI companies, several with India or remote roles
  b('ashby', 'sarvam', 'Sarvam AI', 'startup', true),
  b('greenhouse', 'anthropic', 'Anthropic', 'scaleup', true),
  b('ashby', 'openai', 'OpenAI', 'enterprise', true),
  b('ashby', 'elevenlabs', 'ElevenLabs', 'scaleup', true),
  b('ashby', 'cursor', 'Cursor', 'scaleup', true),
  b('ashby', 'harvey', 'Harvey', 'scaleup', true),
  b('greenhouse', 'togetherai', 'Together AI', 'scaleup', true),
  b('ashby', 'anyscale', 'Anyscale', 'startup', true),
  b('ashby', 'notion', 'Notion', 'scaleup', true),
  b('greenhouse', 'figma', 'Figma', 'enterprise', true),
  b('ashby', 'perplexity', 'Perplexity', 'scaleup', false),
  b('ashby', 'cohere', 'Cohere', 'scaleup', false),
  b('ashby', 'sierra', 'Sierra', 'scaleup', false),
  b('ashby', 'decagon', 'Decagon', 'startup', false),
  b('greenhouse', 'scaleai', 'Scale AI', 'scaleup', false),
  b('ashby', 'langchain', 'LangChain', 'startup', false),

  // Well-known product companies, some remote-first
  b('ashby', 'ramp', 'Ramp', 'scaleup', false),
  b('ashby', 'supabase', 'Supabase', 'startup', false),
  b('greenhouse', 'intercom', 'Intercom', 'scaleup', false),
  b('lever', 'spotify', 'Spotify', 'enterprise', false),
];

const BY_NAME = new Map(BOARDS.map((x) => [x.name.toLowerCase(), x]));

/** The board for a company name, when Tack reads its board. */
export function boardFor(company: string): Board | undefined {
  return BY_NAME.get(company.trim().toLowerCase());
}

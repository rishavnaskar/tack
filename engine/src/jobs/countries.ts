/**
 * Countries as an application form and a profile name them: "India", "the
 * US", "Indian citizen". Enough to tell which country a question about the
 * right to work asks about, and which one the user's own sentence is about.
 */
import { normaliseQuestion } from './wording.ts';

/** Each country by the name kept for it, then the other ways people write it, its demonym among them. */
const NAMES: Array<[string, ...string[]]> = [
  ['India', 'indian', 'bharat'],
  ['United States', 'united states of america', 'usa', 'us', 'u s', 'u s a', 'america', 'american', 'new mexico', 'new england'],
  ['United Kingdom', 'uk', 'u k', 'great britain', 'britain', 'british', 'england', 'scotland', 'wales', 'northern ireland'],
  ['Canada', 'canadian', 'british columbia'],
  ['Australia', 'australian', 'new south wales'],
  ['New Zealand', 'new zealander'],
  ['Ireland', 'irish'],
  ['Germany', 'german', 'deutschland'],
  ['France', 'french'],
  ['Netherlands', 'the netherlands', 'holland', 'dutch'],
  ['Spain', 'spanish'],
  ['Portugal', 'portuguese'],
  ['Italy', 'italian'],
  ['Sweden', 'swedish'],
  ['Norway', 'norwegian'],
  ['Denmark', 'danish'],
  ['Finland', 'finnish'],
  ['Switzerland', 'swiss'],
  ['Austria', 'austrian'],
  ['Belgium', 'belgian'],
  ['Poland', 'polish'],
  ['Singapore', 'singaporean'],
  ['Japan', 'japanese'],
  ['China', 'chinese'],
  ['Hong Kong'],
  ['South Korea', 'korea', 'korean'],
  ['United Arab Emirates', 'uae', 'emirati', 'dubai'],
  ['Saudi Arabia', 'saudi'],
  ['Israel', 'israeli'],
  ['Brazil', 'brazilian'],
  ['Mexico', 'mexican'],
  ['Argentina', 'argentinian', 'argentine'],
  ['South Africa', 'south african'],
  ['Nigeria', 'nigerian'],
  ['Kenya', 'kenyan'],
  ['Pakistan', 'pakistani'],
  ['Bangladesh', 'bangladeshi'],
  ['Sri Lanka', 'sri lankan'],
  ['Nepal', 'nepali', 'nepalese'],
  ['Philippines', 'filipino', 'philippine'],
  ['Indonesia', 'indonesian'],
  ['Malaysia', 'malaysian'],
  ['Vietnam', 'vietnamese'],
  ['Thailand', 'thai'],
  ['European Union', 'eu', 'e u', 'europe', 'european union eu'],
];

/**
 * The rest of the world, so anyone can say where they may work. A question
 * or a sentence of the person's that names one of these names it; a job's
 * location is read with the list above only, since many of these are also
 * the names of towns ("Lebanon, NH").
 */
const MORE: Array<[string, ...string[]]> = [
  ['Afghanistan', 'afghan'], ['Albania', 'albanian'], ['Algeria', 'algerian'], ['Andorra'], ['Angola', 'angolan'],
  ['Antigua and Barbuda'], ['Armenia', 'armenian'], ['Azerbaijan', 'azerbaijani'], ['Bahamas'], ['Bahrain', 'bahraini'],
  ['Barbados'], ['Belarus', 'belarusian'], ['Belize'], ['Benin'], ['Bhutan', 'bhutanese'], ['Bolivia', 'bolivian'],
  ['Bosnia and Herzegovina', 'bosnia', 'bosnian'], ['Botswana'], ['Brunei'], ['Bulgaria', 'bulgarian'], ['Burkina Faso'], ['Burundi'],
  ['Cambodia', 'cambodian'], ['Cameroon', 'cameroonian'], ['Cape Verde', 'cabo verde'], ['Central African Republic'],
  ['Chile', 'chilean'], ['Colombia', 'colombian'], ['Comoros'], ['Republic of the Congo', 'congo brazzaville'],
  ['Democratic Republic of the Congo', 'dr congo', 'drc', 'congo kinshasa'], ['Costa Rica', 'costa rican'],
  ['Côte d’Ivoire', 'cote d ivoire', 'cote divoire', 'ivory coast', 'ivorian'], ['Croatia', 'croatian'], ['Cuba', 'cuban'],
  ['Cyprus', 'cypriot'], ['Czechia', 'czech republic', 'czech'], ['Djibouti'], ['Dominica'], ['Dominican Republic'],
  ['Ecuador', 'ecuadorian'], ['Egypt', 'egyptian'], ['El Salvador', 'salvadoran'], ['Equatorial Guinea'], ['Eritrea', 'eritrean'],
  ['Estonia', 'estonian'], ['Eswatini', 'swaziland'], ['Ethiopia', 'ethiopian'], ['Fiji', 'fijian'], ['Gabon'], ['Gambia', 'the gambia'],
  ['Ghana', 'ghanaian'], ['Greece', 'greek'], ['Grenada'], ['Guatemala', 'guatemalan'], ['Guinea'], ['Guinea-Bissau', 'guinea bissau'],
  ['Guyana', 'guyanese'], ['Haiti', 'haitian'], ['Honduras', 'honduran'], ['Hungary', 'hungarian'], ['Iceland', 'icelandic'],
  ['Iran', 'iranian'], ['Iraq', 'iraqi'], ['Jamaica', 'jamaican'], ['Jordanian'], ['Kazakhstan', 'kazakh'], ['Kiribati'], ['Kosovo', 'kosovar'],
  ['Kuwait', 'kuwaiti'], ['Kyrgyzstan', 'kyrgyz'], ['Laos', 'lao', 'laotian'], ['Latvia', 'latvian'], ['Lebanon', 'lebanese'],
  ['Lesotho'], ['Liberia', 'liberian'], ['Libya', 'libyan'], ['Liechtenstein'], ['Lithuania', 'lithuanian'],
  ['Luxembourg', 'luxembourgish'], ['Macau', 'macao'], ['Madagascar', 'malagasy'], ['Malawi', 'malawian'], ['Maldives', 'maldivian'],
  ['Mali', 'malian'], ['Malta', 'maltese'], ['Marshall Islands'], ['Mauritania', 'mauritanian'], ['Mauritius', 'mauritian'],
  ['Micronesia'], ['Moldova', 'moldovan'], ['Monaco'], ['Mongolia', 'mongolian'], ['Montenegro', 'montenegrin'],
  ['Morocco', 'moroccan'], ['Mozambique', 'mozambican'], ['Myanmar', 'burma', 'burmese'], ['Namibia', 'namibian'], ['Nauru'],
  ['Nicaragua', 'nicaraguan'], ['Niger'], ['North Korea'], ['North Macedonia', 'macedonia', 'macedonian'], ['Oman', 'omani'],
  ['Palau'], ['Palestine', 'palestinian'], ['Panama', 'panamanian'], ['Papua New Guinea'], ['Paraguay', 'paraguayan'],
  ['Peru', 'peruvian'], ['Qatar', 'qatari'], ['Romania', 'romanian'], ['Russia', 'russian federation', 'russian'], ['Rwanda', 'rwandan'],
  ['Saint Kitts and Nevis'], ['Saint Lucia'], ['Saint Vincent and the Grenadines'], ['Samoa', 'samoan'], ['San Marino'],
  ['São Tomé and Príncipe', 'sao tome and principe'], ['Senegal', 'senegalese'], ['Serbia', 'serbian'], ['Seychelles'],
  ['Sierra Leone'], ['Slovakia', 'slovak'], ['Slovenia', 'slovenian'], ['Solomon Islands'], ['Somalia', 'somali'],
  ['South Sudan'], ['Sudan', 'sudanese'], ['Suriname'], ['Syria', 'syrian'], ['Taiwan', 'taiwanese'], ['Tajikistan', 'tajik'],
  ['Tanzania', 'tanzanian'], ['Timor-Leste', 'east timor'], ['Togo'], ['Tonga'], ['Trinidad and Tobago'], ['Tunisia', 'tunisian'],
  ['Turkey', 'turkiye', 'türkiye', 'turkish'], ['Turkmenistan'], ['Tuvalu'], ['Uganda', 'ugandan'], ['Ukraine', 'ukrainian'],
  ['Uruguay', 'uruguayan'], ['Uzbekistan', 'uzbek'], ['Vanuatu'], ['Vatican City', 'holy see'], ['Venezuela', 'venezuelan'],
  ['Yemen', 'yemeni'], ['Zambia', 'zambian'], ['Zimbabwe', 'zimbabwean'],
];

/**
 * Countries whose names are other things too: a US state, a person's first
 * name. They can be picked from the list, but a sentence or a job's location
 * that only says "Georgia" or "Jordan" is not read as naming the country.
 */
const PICK_ONLY: Array<[string, ...string[]]> = [['Georgia'], ['Jordan'], ['Chad']];

/** The demonym listed above for Jordan stands for the country it names. */
const DEMONYM_ONLY: Record<string, string> = { Jordanian: 'Jordan' };

const keptName = (name: string): string => DEMONYM_ONLY[name] ?? name;

/** Every way of writing each, normalised as a question is, longest first so "united states" wins over "us". */
const formsOf = (names: Array<[string, ...string[]]>): Array<{ form: string; country: string }> => names
  .flatMap(([name, ...others]) => [name, ...others].map((w) => ({ form: normaliseQuestion(w), country: keptName(name) })))
  .filter((f) => f.form)
  .sort((a, b) => b.form.length - a.form.length);
const FORMS = formsOf([...NAMES, ...MORE]);
const PLACE_FORMS = formsOf(NAMES);

/** The words of every country's names, for telling a question's country from words it should not have. */
export const COUNTRY_WORDS: ReadonlySet<string> = new Set(FORMS.flatMap((f) => f.form.split(' ')).filter((w) => w.length > 1));

/** Every country found in a text, by the name kept for each, in the order first named. "us" counts only written as a name: "US", "U.S.". */
export function countriesIn(text: string, forms = FORMS): string[] {
  const norm = ` ${normaliseQuestion(text.replace(/\bU\.?S\.?A?\b(?=[\s,.;:?!)]|$)/g, ' usa '))} `;
  const found: Array<{ country: string; at: number }> = [];
  let rest = norm;
  for (const f of forms) {
    // "us" is also a pronoun ("join us"): only "US" or "U.S.", turned into "usa" above, names the country.
    if (f.form === 'us' || f.form === 'u s') continue;
    const at = rest.indexOf(` ${f.form} `);
    if (at === -1) continue;
    if (!found.some((x) => x.country === f.country)) found.push({ country: f.country, at });
    rest = rest.split(` ${f.form} `).join(` ${'_'.repeat(f.form.length)} `);
  }
  return found.sort((a, b) => a.at - b.at).map((x) => x.country);
}

/** The country a text names, by the name kept for it; null when it names none, or several. */
export function countryIn(text: string): string | null {
  const found = countriesIn(text);
  return found.length === 1 ? found[0] : null;
}

/** The country a job's location is in, read from the common names only; null when it names none, or several. */
export function countryOfPlace(place: string): string | null {
  const found = countriesIn(place, PLACE_FORMS);
  return found.length === 1 ? found[0] : null;
}

export const sameCountry = (a: string, b: string): boolean => (countryIn(a) ?? a) === (countryIn(b) ?? b);

/** The kept name of the one country these words are, written any of its ways, or null: "UK" is United Kingdom, "Georgia" is Georgia here. */
export function countryNamed(text: string): string | null {
  const norm = normaliseQuestion(text.replace(/\bU\.?S\.?A?\b(?=[\s,.;:?!)]|$)/g, ' usa ').replace(/\bEU, EEA and Switzerland\b/i, 'European Union'));
  if (!norm) return null;
  for (const [name, ...others] of [...NAMES, ...MORE, ...PICK_ONLY]) {
    if ([name, ...others].some((w) => normaliseQuestion(w) === norm)) return keptName(name);
  }
  return null;
}

/** What the person picks from: every country by its kept name, A to Z, and the free movement area as one place. */
export const COUNTRY_LIST: readonly string[] = [...new Set([...NAMES, ...MORE, ...PICK_ONLY].map(([name]) => keptName(name)))]
  .sort((a, b) => (a === 'European Union' ? 1 : b === 'European Union' ? -1 : a.localeCompare(b, 'en')));

/** The free movement area: the EU's member states, the rest of the EEA, and Switzerland. */
export const FREE_MOVEMENT_AREA: ReadonlySet<string> = new Set([
  'Austria', 'Belgium', 'Bulgaria', 'Croatia', 'Cyprus', 'Czechia', 'Denmark', 'Estonia', 'Finland', 'France', 'Germany', 'Greece',
  'Hungary', 'Ireland', 'Italy', 'Latvia', 'Lithuania', 'Luxembourg', 'Malta', 'Netherlands', 'Poland', 'Portugal', 'Romania',
  'Slovakia', 'Slovenia', 'Spain', 'Sweden', 'Iceland', 'Liechtenstein', 'Norway', 'Switzerland',
]);

/** The name the free movement area is kept under, as the EU is named elsewhere. */
export const FREE_MOVEMENT = 'European Union';

// A realistic application form Tack serves itself, so automated applying can be watched and checked
// end to end without sending anything to a real company.

import { createHash, randomBytes } from 'node:crypto';
import type { Posting } from './types.ts';
import * as store from './store.ts';

export const SUBMISSION_KIND = 'practice-submission';

export interface PracticeQuestion { id: 'q1' | 'q2'; text: string }

export interface PracticeSubmission {
  ref: string; postingId: string; company: string; title: string; at: string;
  values: {
    name: string; email: string; phone: string; location: string; linkedin: string;
    workAuthorisation: string; noticePeriod: string; consent: boolean;
    answers: { question: string; answer: string }[];
  };
  resume: { filename: string; mime: string; size: number; sha256: string; base64: string };
}

export const WORK_AUTH_OPTIONS = [
  'Yes, I am authorised to work in India',
  'No, I will need visa sponsorship',
  'I am authorised to work in another country only',
];
export const NOTICE_OPTIONS = ['Immediately', 'Up to 30 days', '31 to 60 days', '61 to 90 days', 'More than 90 days'];

let ownBase = '';
export function setOwnBase(base: string): void { ownBase = base.replace(/\/$/, ''); }
export function practiceUrl(postingId: string): string {
  const base = ownBase || `http://127.0.0.1:${process.env.TACK_PORT || 4400}`;
  return `${base}/practice/apply/${encodeURIComponent(postingId)}`;
}

const FOCUS: Record<string, string> = {
  ai: 'AI products', agents: 'AI agents', growth: 'growth', platform: 'platform and developer products', data: 'data products',
  analytics: 'analytics products', fintech: 'financial products', consumer: 'consumer products', enterprise: 'enterprise products',
};

/** Two written questions a recruiter would ask for this posting: one on motivation, one on its first must-have skill. */
export function screeningQuestions(p: Pick<Posting, 'title' | 'company' | 'roleFamily' | 'skills'>): PracticeQuestion[] {
  const area = FOCUS[p.roleFamily ?? ''] ?? `the ${p.title} role`;
  const must = p.skills?.find((s) => s.importance === 'must') ?? p.skills?.[0];
  return [
    { id: 'q1', text: `Why do you want to work on ${area} at ${p.company}?` },
    must
      ? { id: 'q2', text: `This role at ${p.company} asks for ${must.name.toLowerCase()}. Describe a time you used it and what changed as a result.` }
      : { id: 'q2', text: `What would you focus on in your first 90 days as ${p.title} at ${p.company}?` },
  ];
}

export function consentText(p: Pick<Posting, 'company'>): string {
  return `I consent to ${p.company} processing my personal data for recruitment, as described in its privacy notice.`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const initials = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');

const STYLE = `
:root{--ink:#1d2430;--mute:#5d6878;--line:#d9dee6;--bg:#f4f6f9;--card:#fff;--brand:#2f5bd3;--err:#b42318}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
header.top{background:#fff;border-bottom:1px solid var(--line)}header.top .in{max-width:760px;margin:0 auto;padding:16px 20px;display:flex;align-items:center;gap:12px}
.logo{width:36px;height:36px;border-radius:8px;background:var(--brand);color:#fff;display:grid;place-items:center;font-weight:700;font-size:14px}
.co{font-weight:600}.careers{color:var(--mute);font-size:14px}
main{max-width:760px;margin:24px auto 64px;padding:0 20px}
.job h1{font-size:26px;margin:0 0 4px}.job p{margin:0;color:var(--mute)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px;margin-top:20px}
ol.steps{list-style:none;display:flex;gap:8px;padding:0;margin:0 0 20px;font-size:14px;color:var(--mute)}
ol.steps li{flex:1;border-top:3px solid var(--line);padding-top:6px}ol.steps li.on{border-color:var(--brand);color:var(--ink);font-weight:600}
h2{font-size:19px;margin:0 0 16px}.f{margin-bottom:16px}label{display:block;font-weight:600;font-size:14px;margin-bottom:6px}
.req{color:var(--err)}.hint{color:var(--mute);font-size:13px;margin:4px 0 0}
input[type=text],input[type=email],input[type=tel],input[type=url],select,textarea{width:100%;padding:10px 12px;border:1px solid #b9c1cd;border-radius:8px;font:inherit;background:#fff}
textarea{min-height:120px;resize:vertical}input[aria-invalid=true],select[aria-invalid=true],textarea[aria-invalid=true]{border-color:var(--err)}
.err{color:var(--err);font-size:13px;margin-top:4px}.check{display:flex;gap:10px;align-items:flex-start}.check label{font-weight:400}
.row{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:600px){.row{grid-template-columns:1fr}}
.acts{display:flex;justify-content:space-between;gap:12px;margin-top:24px}
button{font:inherit;font-weight:600;border-radius:8px;padding:10px 18px;cursor:pointer;border:1px solid var(--brand)}
button.pri{background:var(--brand);color:#fff}button.sec{background:#fff;color:var(--brand)}
dl.review{display:grid;grid-template-columns:200px 1fr;gap:8px 16px;margin:0}dl.review dt{color:var(--mute);font-size:14px}dl.review dd{margin:0;white-space:pre-wrap;word-break:break-word}
.note{font-size:13px;color:var(--mute);margin-top:28px;text-align:center}.done h1{color:#067647}.ref{font:600 20px ui-monospace,Menlo,monospace;letter-spacing:.04em}
`;

function page(title: string, company: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head><body>
<header class="top"><div class="in"><div class="logo" aria-hidden="true">${esc(initials(company))}</div><div><div class="co">${esc(company)}</div><div class="careers">Careers</div></div></div></header>
<main>${body}<p class="note">Practice application served by Tack on this computer. Nothing here is sent to ${esc(company)}.</p></main></body></html>`;
}

function field(id: string, label: string, input: string, hint = ''): string {
  return `<div class="f"><label for="${id}">${esc(label)} <span class="req" aria-hidden="true">*</span></label>${input}${hint ? `<p class="hint">${esc(hint)}</p>` : ''}<div class="err" id="${id}-err" role="alert"></div></div>`;
}

const options = (list: string[]) => `<option value="">Select one</option>${list.map((o) => `<option>${esc(o)}</option>`).join('')}`;

export function renderForm(p: Posting): string {
  const [q1, q2] = screeningQuestions(p);
  const body = `
<section class="job"><h1>${esc(p.title)}</h1><p>${esc(p.company)} · ${esc(p.location || 'Location not stated')}</p></section>
<div class="card">
<form id="apply" novalidate aria-label="Application for ${esc(p.title)}">
<ol class="steps"><li class="on" data-for="1">1. Your details</li><li data-for="2">2. Questions</li><li data-for="3">3. Review</li></ol>
<section data-step="1">
  <h2>Your details</h2>
  ${field('name', 'Full name', '<input type="text" id="name" name="name" autocomplete="name" required>')}
  <div class="row">
  ${field('email', 'Email', '<input type="email" id="email" name="email" autocomplete="email" required>')}
  ${field('phone', 'Phone', '<input type="tel" id="phone" name="phone" autocomplete="tel" required>')}
  </div>
  <div class="row">
  ${field('location', 'Current city', '<input type="text" id="location" name="location" autocomplete="address-level2" required>')}
  ${field('linkedin', 'LinkedIn profile URL', '<input type="url" id="linkedin" name="linkedin" required>')}
  </div>
  ${field('resume', 'Résumé', '<input type="file" id="resume" name="resume" accept=".pdf,.doc,.docx,.txt,.rtf" required>', 'PDF, Word or text, up to 10 MB.')}
  <div class="acts"><span></span><button type="button" class="pri" data-next="2">Continue</button></div>
</section>
<section data-step="2" hidden>
  <h2>A few questions</h2>
  ${field('workAuthorisation', 'Are you legally authorised to work in India?', `<select id="workAuthorisation" name="workAuthorisation" required>${options(WORK_AUTH_OPTIONS)}</select>`)}
  ${field('noticePeriod', 'What is your notice period?', `<select id="noticePeriod" name="noticePeriod" required>${options(NOTICE_OPTIONS)}</select>`)}
  ${field('q1', q1.text, '<textarea id="q1" name="q1" maxlength="2000" required></textarea>')}
  ${field('q2', q2.text, '<textarea id="q2" name="q2" maxlength="2000" required></textarea>')}
  <div class="f check"><input type="checkbox" id="consent" name="consent" required><label for="consent">${esc(consentText(p))} <span class="req" aria-hidden="true">*</span></label></div>
  <div class="err" id="consent-err" role="alert"></div>
  <div class="acts"><button type="button" class="sec" data-back="1">Back</button><button type="button" class="pri" data-next="3">Review application</button></div>
</section>
<section data-step="3" hidden>
  <h2>Review your application</h2>
  <dl class="review" id="review"></dl>
  <div class="err" id="submit-err" role="alert"></div>
  <div class="acts"><button type="button" class="sec" data-back="2">Edit answers</button><button type="submit" class="pri" id="submit">Submit application</button></div>
</section>
</form></div>
<script>
(function(){
var form=document.getElementById('apply');
var LABELS={name:'Full name',email:'Email',phone:'Phone',location:'Current city',linkedin:'LinkedIn profile URL',resume:'Résumé',workAuthorisation:'Work authorisation',noticePeriod:'Notice period',q1:${JSON.stringify(q1.text)},q2:${JSON.stringify(q2.text)},consent:'Consent'};
function show(n){form.querySelectorAll('section[data-step]').forEach(function(s){s.hidden=s.getAttribute('data-step')!==String(n)});form.querySelectorAll('ol.steps li').forEach(function(l){l.classList.toggle('on',l.getAttribute('data-for')===String(n))});window.scrollTo(0,0)}
function check(n){var ok=true,first=null;form.querySelectorAll('section[data-step="'+n+'"] [required]').forEach(function(el){var msg='';
 if(el.type==='checkbox'){if(!el.checked)msg='Please confirm to continue.'}
 else if(el.type==='file'){if(!el.files||!el.files.length)msg='Attach your résumé.';else if(el.files[0].size>10485760)msg='The file is larger than 10 MB.'}
 else if(!el.value.trim())msg='This field is required.';
 else if(el.type==='email'&&!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(el.value.trim()))msg='Enter a valid email address.';
 else if(el.type==='url'&&!/^(https?:\\/\\/)?([\\w-]+\\.)+[\\w-]+(\\/\\S*)?$/i.test(el.value.trim()))msg='Enter a valid link.';
 var e=document.getElementById(el.id+'-err');if(e)e.textContent=msg;el.setAttribute('aria-invalid',msg?'true':'false');if(msg){ok=false;first=first||el}});
 if(first)first.focus();return ok}
function review(){var dl=document.getElementById('review');dl.innerHTML='';Object.keys(LABELS).forEach(function(k){var el=form.elements[k];var v=el.type==='file'?(el.files[0]?el.files[0].name:''):el.type==='checkbox'?(el.checked?'Agreed':'Not agreed'):el.value;var dt=document.createElement('dt');dt.textContent=LABELS[k];var dd=document.createElement('dd');dd.textContent=v;dl.appendChild(dt);dl.appendChild(dd)})}
form.addEventListener('click',function(ev){var b=ev.target.closest('button');if(!b)return;var next=b.getAttribute('data-next'),back=b.getAttribute('data-back');
 if(next){var cur=Number(next)-1;if(!check(cur))return;if(next==='3')review();show(next)}
 if(back)show(back)});
function b64(file){return new Promise(function(ok,fail){var r=new FileReader();r.onload=function(){var s=String(r.result);ok(s.slice(s.indexOf(',')+1))};r.onerror=function(){fail(r.error)};r.readAsDataURL(file)})}
var sending=false;
form.addEventListener('submit',function(ev){ev.preventDefault();if(sending)return;if(!check(1)){show(1);return}if(!check(2)){show(2);return}
 sending=true;var btn=document.getElementById('submit');btn.disabled=true;btn.textContent='Submitting…';var f=form.elements.resume.files[0];
 b64(f).then(function(data){return fetch('/api/practice/apply/${encodeURIComponent(p.id)}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
  name:form.elements.name.value,email:form.elements.email.value,phone:form.elements.phone.value,location:form.elements.location.value,linkedin:form.elements.linkedin.value,
  workAuthorisation:form.elements.workAuthorisation.value,noticePeriod:form.elements.noticePeriod.value,consent:form.elements.consent.checked,
  answers:[{question:LABELS.q1,answer:form.elements.q1.value},{question:LABELS.q2,answer:form.elements.q2.value}],
  resume:{filename:f.name,mime:f.type||'application/octet-stream',base64:data}})})})
 .then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'The application could not be sent.');location.assign(j.next)})})
 .catch(function(e){sending=false;btn.disabled=false;btn.textContent='Submit application';document.getElementById('submit-err').textContent=e.message})});
})();
</script>`;
  return page(`Apply: ${p.title} at ${p.company}`, p.company, body);
}

export function renderConfirmation(s: PracticeSubmission): string {
  const body = `
<div class="card done" role="status">
  <h1>Application submitted</h1>
  <p>Thank you, ${esc(s.values.name.split(/\s+/)[0] || s.values.name)}. Your application for <strong>${esc(s.title)}</strong> at ${esc(s.company)} has been received.</p>
  <p>Your reference number is <span class="ref" id="reference">${esc(s.ref)}</span></p>
  <p>We sent a confirmation to ${esc(s.values.email)}. The hiring team reviews every application and will be in touch if there is a match.</p>
</div>`;
  return page(`Application submitted: ${s.title} at ${s.company}`, s.company, body);
}

export function renderMissing(message: string): string {
  return page('Application not found', 'Careers', `<div class="card"><h1>Not found</h1><p>${esc(message)}</p></div>`);
}

const str = (v: unknown, max = 300) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

export class SubmissionError extends Error {}

/** Checks a submission the way the form does and stores it. */
export function acceptSubmission(p: Posting, body: any, now = new Date()): PracticeSubmission {
  const v = {
    name: str(body?.name), email: str(body?.email), phone: str(body?.phone), location: str(body?.location), linkedin: str(body?.linkedin),
    workAuthorisation: str(body?.workAuthorisation), noticePeriod: str(body?.noticePeriod), consent: body?.consent === true,
  };
  const missing = Object.entries(v).filter(([, x]) => x === '' || x === false).map(([k]) => k);
  if (missing.length) throw new SubmissionError(`Missing: ${missing.join(', ')}`);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) throw new SubmissionError('Enter a valid email address.');
  if (!WORK_AUTH_OPTIONS.includes(v.workAuthorisation)) throw new SubmissionError('Pick a work authorisation answer from the list.');
  if (!NOTICE_OPTIONS.includes(v.noticePeriod)) throw new SubmissionError('Pick a notice period from the list.');
  const asked = screeningQuestions(p);
  const answers = asked.map((q, i) => ({ question: q.text, answer: typeof body?.answers?.[i]?.answer === 'string' ? body.answers[i].answer.trim().slice(0, 2000) : '' }));
  if (answers.some((a) => !a.answer)) throw new SubmissionError('Answer both questions.');
  const r = body?.resume;
  const base64 = typeof r?.base64 === 'string' ? r.base64.replace(/^data:[^,]*,/, '') : '';
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length) throw new SubmissionError('Attach your résumé.');
  if (bytes.length > 10 * 1024 * 1024) throw new SubmissionError('The résumé is larger than 10 MB.');
  const sub: PracticeSubmission = {
    ref: `TQ-${randomBytes(4).toString('hex').toUpperCase()}`,
    postingId: p.id, company: p.company, title: p.title, at: now.toISOString(),
    values: { ...v, answers },
    resume: {
      filename: str(r?.filename, 200) || 'resume', mime: str(r?.mime, 100) || 'application/octet-stream', size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64'),
    },
  };
  store.put(SUBMISSION_KIND, sub.ref, sub);
  return sub;
}

export function submissions(postingId?: string): PracticeSubmission[] {
  const all = store.list<PracticeSubmission>(SUBMISSION_KIND);
  return postingId ? all.filter((s) => s.postingId === postingId) : all;
}

/** Without the file itself: what a list or a test needs to see. */
export function summary(s: PracticeSubmission): Omit<PracticeSubmission, 'resume'> & { resume: Omit<PracticeSubmission['resume'], 'base64'> } {
  const { base64: _b, ...resume } = s.resume;
  return { ...s, resume };
}

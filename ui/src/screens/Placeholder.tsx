import { Button, EmptyState, PageHeader } from '../ui';

type ScreenId = 'plan' | 'portfolio' | 'interview' | 'tracker' | 'progress' | 'missing';

const COPY: Record<ScreenId, { index: string; section: string; title: string; purpose: string; empty: string; body: string }> = {
  plan: {
    index: '03',
    section: 'Plan',
    title: 'The move, week by week',
    purpose: 'Tasks sized to your hours, a checkpoint at the end of each week, and a replan when a week slips.',
    empty: 'Week columns land here next',
    body: 'Tasks, hours and checkpoints for each week, built from the gap map. Ticking a task updates progress; a replan shows what moved and why.',
  },
  portfolio: {
    index: '04',
    section: 'Portfolio',
    title: 'Proof you can show',
    purpose: 'Three projects that each close at least two open gaps, tied to plan weeks and to lines from real postings.',
    empty: 'Project cards land here next',
    body: 'Each project lists the skills it covers, its milestones, what a reviewer sees, and the posting lines it answers.',
  },
  interview: {
    index: '05',
    section: 'Interview',
    title: 'Practise the questions they will ask',
    purpose: 'One question at a time, scored on five criteria, with a stronger version of your own answer.',
    empty: 'Interview practice lands here next',
    body: 'Questions come from your target postings and open gaps. Each answer gets five scored bars with reasons, a better answer and a follow-up.',
  },
  tracker: {
    index: '06',
    section: 'Tracker',
    title: 'Learn from who replies',
    purpose: 'Every application by status, what gets replies, and the postings to apply to next.',
    empty: 'The tracker lands here next',
    body: 'A board by status, segment bars showing which kinds of roles reply, plain lessons, and a ranked apply-next list.',
  },
  progress: {
    index: '07',
    section: 'Progress',
    title: 'How far you have come',
    purpose: 'Readiness over time, hours put in, your streak, and the three things worth doing today.',
    empty: 'Progress lands here next',
    body: 'Readiness history, hours against plan, streak and the daily brief, all from the work you log.',
  },
  missing: {
    index: '--',
    section: 'Not found',
    title: 'Nothing at this address',
    purpose: 'The page you asked for does not exist.',
    empty: 'Try the start screen',
    body: 'Use the rail to move between sections.',
  },
};

export function Placeholder({ screen }: { screen: ScreenId }) {
  const c = COPY[screen];
  return (
    <>
      <PageHeader index={c.index} section={c.section} title={c.title} purpose={c.purpose} />
      <EmptyState
        eyebrow={screen === 'missing' ? 'Not found' : 'In progress'}
        title={c.empty}
        body={c.body}
        action={
          screen === 'missing' ? (
            <Button to="/" variant="primary" icon="arrow-right">
              Go to Start
            </Button>
          ) : (
            <Button to="/gap" variant="ghost" icon="arrow-right">
              Open the gap map
            </Button>
          )
        }
      />
    </>
  );
}

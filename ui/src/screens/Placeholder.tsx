import { Button, EmptyState, PageHeader } from '../ui';

type ScreenId = 'plan' | 'portfolio' | 'interview' | 'tracker' | 'progress' | 'missing';

const COPY: Record<ScreenId, { index: string; section: string; title: string; purpose: string; empty: string; body: string }> = {
  plan: {
    index: '03',
    section: 'Plan',
    title: 'Your plan, week by week',
    purpose: 'Tasks sized to your hours, a checkpoint at the end of each week, and a replan when a week slips.',
    empty: 'Week columns land here next',
    body: 'Tasks, hours and checkpoints for each week, built from the gap map. Ticking a task updates progress; a replan shows what moved and why.',
  },
  portfolio: {
    index: '04',
    section: 'Portfolio',
    title: 'Work you can show',
    purpose: 'Three projects that each cover at least two skill gaps, linked to real job posts.',
    empty: 'Project cards will show up here.',
    body: 'Each project shows the skills covered, key milestones, and matches to real job posts.',
  },
  interview: {
    index: '05',
    section: 'Interview',
    title: 'Practice questions you might get asked',
    purpose: 'One question at a time, scored on five criteria, with a stronger version of your own answer.',
    empty: 'Interview practice will show up here.',
    body: 'Questions come from target jobs and skill gaps. Each answer gets five scores, feedback, an improved version, and a follow-up.',
  },
  tracker: {
    index: '06',
    section: 'Tracker',
    title: 'See who responds',
    purpose: 'Track your applications, see who replies, and find where to apply next.',
    empty: 'The tracker will show up here.',
    body: 'An application board, response rates by role, simple takeaways, and where to apply next.',
  },
  progress: {
    index: '07',
    section: 'Progress',
    title: "How far you've come",
    purpose: 'Track your readiness, hours spent, current streak, and three key tasks for today.',
    empty: 'Progress lands here next',
    body: 'Readiness history, logged hours, your streak, and a daily update based on your work.',
  },
  missing: {
    index: '--',
    section: 'Not found',
    title: 'Nothing here',
    purpose: "This page doesn't exist.",
    empty: 'Go to the start screen',
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

/** Bringing the user's own profile in from a job site they are signed in to, at a host's request. */
import { importDeps, importSiteProfile, isSiteId, SITE_IDS } from '../../jobs/site-profiles.ts';
import type { Tool } from '../protocol.ts';
import { aboutTheUser, type FanfoldContext } from '../context.ts';

/** What the host is told beside the reading's own result. */
export const COPY = {
  confirm: 'What was read is kept as the document "{title}" and is NOT used to answer for the user until they confirm it is theirs on Fanfold\'s Profile page ("This is mine, use it to answer"). Tell them so.',
  unknownSite: 'Fanfold reads profiles only from: {sites}.',
};

export function profileTools(ctx: FanfoldContext): Tool[] {
  const importTool: Tool = {
    name: 'profile_import',
    title: 'Read the user\'s own profile from a job site',
    description:
      'Open the user\'s OWN profile on LinkedIn, Naukri, Instahyre, Indeed or Wellfound in a window they can watch, read it '
      + '(at most 8 pages, a few seconds apart) and keep its text as a document Fanfold answers applications from. '
      + 'It never signs in and never handles a check: if the user is signed out or the site shows one, it stops and says so. '
      + 'Other people\'s profiles, recommendations and messages are never read. What it reads waits for the user to confirm on '
      + 'Fanfold\'s Profile page before it answers anything. Use it when job_profile is thin, once per site.',
    inputSchema: {
      type: 'object', required: ['site'], additionalProperties: false,
      properties: { site: { type: 'string', enum: [...SITE_IDS], description: 'Which site to read the user\'s own profile from.' } },
    },
    run: async (args, call) => {
      const site = args.site;
      if (!isSiteId(site)) return { text: COPY.unknownSite.replace('{sites}', SITE_IDS.join(', ')), isError: true };
      call.progress(`reading the user's ${site} profile`);
      const r = await importSiteProfile(importDeps(ctx.app), site, { startedBy: 'agent', by: call.client.name });
      const title = r.documentId ? ctx.app.memory.listDocuments().find((d) => d.id === r.documentId)?.title ?? '' : '';
      const said = aboutTheUser(r.message);
      const text = r.status === 'imported' ? `${said}\n${COPY.confirm.replace('{title}', title)}` : said;
      return { text, isError: r.status === 'failed' };
    },
  };
  return [importTool];
}

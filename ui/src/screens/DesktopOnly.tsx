import type { ReactNode } from 'react';
import { useHosted } from '../api/capabilities';
import { Button, EmptyState } from '../ui';

/** What a screen shows on the web preview in place of a feature that runs only in the desktop app. */
export function DesktopOnly({ title, body, compact }: { title: ReactNode; body: ReactNode; compact?: boolean }) {
  const hosted = useHosted();
  return (
    <EmptyState
      compact={compact}
      eyebrow="Desktop app"
      title={title}
      body={body}
      action={
        hosted?.downloadUrl ? (
          <Button variant="ghost" size={compact ? 'sm' : 'md'} icon="arrow-up-right" href={hosted.downloadUrl}>
            Get the desktop app
          </Button>
        ) : undefined
      }
    />
  );
}

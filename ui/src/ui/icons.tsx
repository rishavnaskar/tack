import type { ReactElement, SVGProps } from 'react';

export type IconName =
  | 'arrow-right'
  | 'arrow-up-right'
  | 'arrow-left'
  | 'close'
  | 'check'
  | 'plus'
  | 'minus'
  | 'upload'
  | 'file'
  | 'grid'
  | 'list'
  | 'constellation'
  | 'refresh'
  | 'chevron-down'
  | 'chevron-up'
  | 'search'
  | 'sort'
  | 'warning'
  | 'dot';

const paths: Record<IconName, ReactElement> = {
  'arrow-right': <path d="M4 10h11M11 5.5 15.5 10 11 14.5" />,
  'arrow-up-right': <path d="M6 14 14 6M7.5 6H14v6.5" />,
  'arrow-left': <path d="M16 10H5M9 5.5 4.5 10 9 14.5" />,
  close: <path d="m5.5 5.5 9 9M14.5 5.5l-9 9" />,
  check: <path d="m4.5 10.5 3.5 3.5 7.5-8" />,
  plus: <path d="M10 4.5v11M4.5 10h11" />,
  minus: <path d="M4.5 10h11" />,
  upload: <path d="M10 13.5V4M6 7.5 10 3.5l4 4M4 13v2.5h12V13" />,
  file: (
    <>
      <path d="M5.5 2.5h6l3.5 3.5v11.5h-9.5z" />
      <path d="M11.5 2.5V6H15" />
    </>
  ),
  grid: (
    <>
      <rect x="3.5" y="3.5" width="5" height="5" />
      <rect x="11.5" y="3.5" width="5" height="5" />
      <rect x="3.5" y="11.5" width="5" height="5" />
      <rect x="11.5" y="11.5" width="5" height="5" />
    </>
  ),
  list: <path d="M7 5.5h9.5M7 10h9.5M7 14.5h9.5M3.5 5.5h.5M3.5 10h.5M3.5 14.5h.5" />,
  constellation: (
    <>
      <circle cx="5" cy="6" r="2" />
      <circle cx="14.5" cy="5" r="1.4" />
      <circle cx="12" cy="14" r="2.6" />
      <path d="m6.8 7 4 5M13.9 6.4l-1.3 5" />
    </>
  ),
  refresh: <path d="M15.5 8.5A5.8 5.8 0 0 0 5 6.3M4.5 11.5A5.8 5.8 0 0 0 15 13.7M5 3v3.5h3.5M15 17v-3.5h-3.5" />,
  'chevron-down': <path d="m5.5 8 4.5 4.5L14.5 8" />,
  'chevron-up': <path d="M5.5 12 10 7.5l4.5 4.5" />,
  search: (
    <>
      <circle cx="9" cy="9" r="5" />
      <path d="m12.8 12.8 3.7 3.7" />
    </>
  ),
  sort: <path d="M6.5 4v12M3.5 13l3 3 3-3M13.5 16V4M10.5 7l3-3 3 3" />,
  warning: (
    <>
      <path d="M10 3.5 17 16H3z" />
      <path d="M10 8.5v3.5M10 14v.2" />
    </>
  ),
  dot: <circle cx="10" cy="10" r="3" fill="currentColor" />,
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 18, strokeWidth = 1.5, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {paths[name]}
    </svg>
  );
}

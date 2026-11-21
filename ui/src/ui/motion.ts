export const ease = [0.22, 1, 0.36, 1] as const;
export const easeInOut = [0.65, 0, 0.35, 1] as const;

export const settle = {
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.8, ease },
};

export function stagger(i: number, step = 0.04, base = 0) {
  return { duration: 0.7, ease, delay: base + Math.min(i, 24) * step };
}

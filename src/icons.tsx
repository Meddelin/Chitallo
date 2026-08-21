// Пять UI-глифов (WP-K): один оптический размер (14 px, viewBox 16), stroke
// 1.5, currentColor — цвет, hover и контраст приходят от родителя, как у
// текста. Заменяют разнокалиберные символьные псевдо-иконки (☾ ☀ ▾ × ✕).

type IconProps = { size?: number; className?: string };

function Svg({ size = 14, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`inline-block shrink-0 align-[-0.125em] ${className ?? ""}`}
    >
      {children}
    </svg>
  );
}

export function IconMoon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M13.2 9.9A5.6 5.6 0 0 1 6.1 2.8 5.9 5.9 0 1 0 13.2 9.9Z" />
    </Svg>
  );
}

export function IconSun(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="2.6" />
      <path d="M8 1.4v1.9M8 12.7v1.9M1.4 8h1.9M12.7 8h1.9M3.3 3.3l1.4 1.4M11.3 11.3l1.4 1.4M12.7 3.3l-1.4 1.4M4.7 11.3l-1.4 1.4" />
    </Svg>
  );
}

export function IconClose(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  );
}

/* настройки (WP-L): два слайдера — жест «подстроить», без шестерёночного клише */
export function IconSliders(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2 5h5.6M11.4 5H14M2 11h2.6M8.4 11H14" />
      <circle cx="9.5" cy="5" r="1.9" />
      <circle cx="6.5" cy="11" r="1.9" />
    </Svg>
  );
}

/* переключатель колонок: 1, 2 или «авто» (3 узкие) страницы в ряд */
export function IconColumns({ n, size = 14, className }: IconProps & { n: 1 | 2 | 3 }) {
  return (
    <Svg size={size} className={className}>
      {n === 1 ? (
        <rect x="4.25" y="2.75" width="7.5" height="10.5" rx="1" />
      ) : n === 2 ? (
        <>
          <rect x="1.75" y="2.75" width="5.5" height="10.5" rx="1" />
          <rect x="8.75" y="2.75" width="5.5" height="10.5" rx="1" />
        </>
      ) : (
        <>
          <rect x="1" y="2.75" width="3.8" height="10.5" rx="1" />
          <rect x="6.1" y="2.75" width="3.8" height="10.5" rx="1" />
          <rect x="11.2" y="2.75" width="3.8" height="10.5" rx="1" />
        </>
      )}
    </Svg>
  );
}

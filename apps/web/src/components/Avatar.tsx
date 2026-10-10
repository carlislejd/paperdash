export function Avatar({ address }: { address: string }) {
  const seed = parseInt(address.slice(2, 8), 16) || 17;
  const colors = ["#d8d2ed", "#dce4cb", "#efd4c0", "#cbdedc", "#e8d1dc"];
  return (
    <span
      className="avatar"
      style={{ background: colors[seed % colors.length] }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 36 36">
        <path
          d={
            seed % 2
              ? "M8 29V14l5-6 5 4 5-4 5 6v15z"
              : "M7 28V16l5-8 6 3 6-3 5 8v12z"
          }
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M12 19h2m8 0h2m-9 5q3 3 6 0"
          stroke="currentColor"
          strokeWidth="1.5"
          fill="none"
        />
        <path d="m7 23 5 1m17-1-5 1" stroke="currentColor" opacity=".45" />
      </svg>
    </span>
  );
}

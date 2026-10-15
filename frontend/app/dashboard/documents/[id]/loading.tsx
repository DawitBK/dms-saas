export default function DocumentDetailLoading() {
  return (
    <div className="flex-1 overflow-y-auto min-h-0 p-6 space-y-4">
      <div className="ui-card">
        <div className="ui-skeleton h-6 w-96 rounded mb-3" />
        <div className="ui-skeleton h-4 w-56 rounded" />
      </div>
      <div className="flex gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="ui-skeleton h-9 w-24 rounded-lg" />
        ))}
      </div>
      <div className="ui-card">
        <div className="ui-skeleton h-96 w-full rounded-xl" />
      </div>
    </div>
  );
}

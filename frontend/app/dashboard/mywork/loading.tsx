export default function MyWorkLoading() {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      <div className="ui-skeleton h-8 w-48 rounded mb-2" />
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="ui-card">
            <div className="ui-skeleton h-5 w-64 rounded mb-2" />
            <div className="ui-skeleton h-4 w-40 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}

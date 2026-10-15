export default function OperationsLoading() {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      <div className="flex gap-2 mb-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="ui-skeleton h-9 w-28 rounded-lg" />
        ))}
      </div>
      <div className="ui-card space-y-2">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="ui-skeleton h-11 rounded-lg" />
        ))}
      </div>
    </div>
  );
}

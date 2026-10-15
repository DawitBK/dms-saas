export default function BrowseLoading() {
  return (
    <div className="flex-1 flex min-h-0">
      <div className="w-64 border-r p-4 space-y-2 hidden md:block">
        <div className="ui-skeleton h-5 w-32 rounded mb-4" />
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="ui-skeleton h-8 rounded-lg" />
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-6 space-y-2">
        <div className="ui-skeleton h-8 w-64 rounded mb-4" />
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="ui-card">
            <div className="ui-skeleton h-5 w-72 rounded mb-2" />
            <div className="ui-skeleton h-4 w-40 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}

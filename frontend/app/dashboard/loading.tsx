export default function DashboardLoading() {
  return (
    <div className="flex-1 overflow-y-auto min-h-0 p-6 space-y-6">
      {/* Metric cards skeleton */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="ui-card">
            <div className="ui-skeleton h-4 w-24 rounded mb-3" />
            <div className="ui-skeleton h-8 w-16 rounded" />
          </div>
        ))}
      </div>

      {/* Main grid skeleton */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 ui-card space-y-2">
          <div className="ui-skeleton h-5 w-40 rounded mb-4" />
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="ui-skeleton h-10 rounded-lg" />
          ))}
        </div>
        <div className="space-y-4">
          <div className="ui-card">
            <div className="ui-skeleton h-5 w-32 rounded mb-4" />
            <div className="ui-skeleton h-32 rounded-xl" />
          </div>
          <div className="ui-card">
            <div className="ui-skeleton h-5 w-28 rounded mb-3" />
            <div className="grid grid-cols-2 gap-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="ui-skeleton h-16 rounded-xl" />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

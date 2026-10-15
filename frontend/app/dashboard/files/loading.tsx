export default function FilesLoading() {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      <div className="ui-skeleton h-10 w-80 rounded-lg" />
      <div className="ui-card space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="ui-skeleton h-12 rounded-lg" />
        ))}
      </div>
    </div>
  );
}

export default function UploadLoading() {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4 max-w-3xl">
      <div className="ui-skeleton h-8 w-48 rounded mb-2" />
      <div className="ui-card space-y-3">
        <div className="ui-skeleton h-40 w-full rounded-xl" />
        <div className="ui-skeleton h-10 w-full rounded-lg" />
        <div className="ui-skeleton h-10 w-full rounded-lg" />
        <div className="ui-skeleton h-10 w-2/3 rounded-lg" />
      </div>
    </div>
  );
}

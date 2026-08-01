/** A consistent, accessible required-field indicator for form labels. */
export function RequiredMark() {
  return (
    <>
      <span aria-hidden="true" className="ml-0.5 text-red-500">*</span>
      <span className="sr-only"> (required)</span>
    </>
  );
}

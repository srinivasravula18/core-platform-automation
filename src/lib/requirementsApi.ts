export async function fetchRequirementsList() {
  const response = await fetch('/api/requirements');
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

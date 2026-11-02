const unavailable = 'CoW Light service is unavailable for this dashboard. Please try again later.';

export async function readCowResponse<T>(response: Response, fallback = 'CoW Light is not available for this network yet.'): Promise<T> {
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json' && !contentType?.endsWith('+json')) {
    throw new Error(unavailable);
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new Error('CoW Light returned an invalid response. Please try again.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('CoW Light returned an invalid response. Please try again.');
  }
  if (!response.ok) {
    const failure = data as { status?: unknown; error?: unknown };
    throw new Error(failure.status === 'deployment_required'
      ? 'CoW Light needs a verified deployment for the current network. Trading is disabled.'
      : typeof failure.error === 'string' && failure.error ? failure.error : fallback);
  }
  return data as T;
}

export async function cowApi<T>(path: string, init?: RequestInit, fallback?: string): Promise<T> {
  // An old upstream can return cacheable dashboard HTML for an API URL.
  // Recheck the service instead of retaining that response after recovery.
  const response = await fetch(`${import.meta.env.BASE_URL}cowdemo/api${path}`, { ...init, cache: 'no-store' });
  return readCowResponse<T>(response, fallback);
}

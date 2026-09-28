
export function assertLocalBackend(backendClient, operation) {
  if (backendClient?.type !== "remote") {return;}

  const error = new Error(`${operation}: is not supported by the remote backend`);
  error.code = "REMOTE_UNSUPPORTED_OPERATION";
  error.details = { backend: "remote", operation };
  throw error;
}

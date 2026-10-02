export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}
export const unavailable = () => new ApiError(503, 'SERVICE_UNAVAILABLE', 'Availability temporarily unavailable.');
export const unauthenticated = () => new ApiError(401, 'UNAUTHENTICATED', 'A valid access token is required.');
export function errorBody(error) {
  return { serverTime: new Date().toISOString(), error: {
    code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}),
  } };
}

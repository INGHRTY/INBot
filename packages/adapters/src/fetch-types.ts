/**
 * The fetch input and header shapes, written out rather than taken from the browser types.
 *
 * Neither the server nor the desktop app's type program includes the DOM library, and
 * both talk to providers over fetch, so the shapes are spelled out here once.
 */
export type FetchInput = string | URL | Request;

export type FetchHeaders = NonNullable<RequestInit["headers"]>;

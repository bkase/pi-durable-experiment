import { Schema } from "effect"

/** Client → chat, over the WebSocket. Each request carries an id its response echoes. */
export const ClientMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("input"), id: Schema.String, text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("abort"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("status"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("view"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("zoom"), id: Schema.String, at: Schema.Number, n: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("instructions.get"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("instructions.set"), id: Schema.String, text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("login.start"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("login.finish"), id: Schema.String, url: Schema.String })
])
export type ClientMessage = typeof ClientMessage.Type

/** Chat → client. `events` frames carry pi-durable agent events for live display. */
export type ServerMessage =
  | { readonly type: "hello"; readonly status: unknown }
  | { readonly type: "result"; readonly id: string; readonly ok: true; readonly data: unknown }
  | { readonly type: "result"; readonly id: string; readonly ok: false; readonly error: string }
  | { readonly type: "events"; readonly events: ReadonlyArray<unknown> }
  | { readonly type: "snapshot"; readonly snapshot: unknown }

export const decodeClientMessage = Schema.decodeUnknownSync(Schema.fromJsonString(ClientMessage))

export * as ReviewForm from "./form.js"

import { Schema } from "effect"

export const MAX_FIELDS = 20
export const MAX_OPTIONS = 20
const ID = /^[A-Za-z0-9_.-]{1,64}$/

export const Option = Schema.Struct({
  id: Schema.String.annotate({ description: "Stable id echoed in the answer, [A-Za-z0-9_.-], max 64" }),
  label: Schema.String,
})
export type Option = typeof Option.Type

export const When = Schema.Struct({
  field: Schema.String.annotate({ description: "Id of another field in this form" }),
  equals: Schema.Union([Schema.String, Schema.Array(Schema.String)]).annotate({
    description: "Show (and require) this field when that field's value is one of these option ids or strings",
  }),
})
export type When = typeof When.Type

export const Field = Schema.Struct({
  id: Schema.String.annotate({ description: "Stable id unique within the item, echoed in answers" }),
  type: Schema.Literals(["choice", "multi", "text"]).annotate({
    description: "choice: pick one option; multi: pick many; text: free text",
  }),
  label: Schema.String,
  required: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "Must be answered when the field is visible" }),
  ),
  options: Schema.optionalKey(Schema.Array(Option).annotate({ description: "Required for choice and multi" })),
  placeholder: Schema.optionalKey(Schema.String.annotate({ description: "text only" })),
  when: Schema.optionalKey(
    When.annotate({
      description: "Only show, and only require, this field when another field's value is listed in equals",
    }),
  ),
})
export type Field = typeof Field.Type

export const Answer = Schema.Union([Schema.String, Schema.Array(Schema.String)])
export type Answer = typeof Answer.Type
export type Answers = { readonly [id: string]: Answer }

export function equalsList(equals: string | readonly string[]): readonly string[] {
  return typeof equals === "string" ? [equals] : [...equals]
}

/** Whether a field is shown, given the current answers. Hidden fields are not required. */
export function visible(field: Field, answers: Answers | undefined): boolean {
  if (!field.when) return true
  const value = answers?.[field.when.field]
  const want = equalsList(field.when.equals)
  if (Array.isArray(value)) return value.some((entry) => want.includes(entry))
  return typeof value === "string" && want.includes(value)
}

export function visibleFields(fields: ReadonlyArray<Field>, answers: Answers | undefined) {
  return fields.filter((field) => visible(field, answers))
}

export function isAnswered(field: Field, answers: Answers | undefined): boolean {
  const value = answers?.[field.id]
  if (field.type === "multi") return Array.isArray(value) && value.length > 0
  return typeof value === "string" && value.trim() !== ""
}

/** Visible required fields that still have no answer. */
export function missing(fields: ReadonlyArray<Field>, answers: Answers | undefined) {
  return visibleFields(fields, answers).filter((field) => field.required && !isAnswered(field, answers))
}

const PASS = new Set(["pass", "ok", "yes", "通过"])
const FAIL = new Set(["fail", "no", "ng", "不通过"])

function norm(value: string) {
  return value.trim().toLowerCase()
}

export function optionPolarity(option: Option): "pass" | "fail" | undefined {
  const id = norm(option.id)
  const label = norm(option.label)
  if (PASS.has(id) || PASS.has(label) || PASS.has(option.label.trim())) return "pass"
  if (FAIL.has(id) || FAIL.has(label) || FAIL.has(option.label.trim())) return "fail"
  return undefined
}

/** A two-option choice whose options are a natural pass / fail pair. */
export function isPassFail(field: Field): boolean {
  if (field.type !== "choice" || field.options?.length !== 2) return false
  const polarities = field.options.map(optionPolarity)
  return polarities.includes("pass") && polarities.includes("fail")
}

/**
 * The visible two-option choice that P / F should drive: a natural pass / fail field, or the only
 * required two-option choice.
 */
export function passFailField(fields: ReadonlyArray<Field>, answers: Answers | undefined): Field | undefined {
  const choices = visibleFields(fields, answers).filter(
    (field) => field.type === "choice" && field.options?.length === 2,
  )
  const natural = choices.find(isPassFail)
  if (natural) return natural
  const required = choices.filter((field) => field.required)
  return required.length === 1 ? required[0] : undefined
}

/** Option id that P or F should set on this field. */
export function optionFor(field: Field, polarity: "pass" | "fail"): string | undefined {
  const match = field.options?.find((option) => optionPolarity(option) === polarity)
  if (match) return match.id
  if (field.options?.length === 2 && !isPassFail(field)) return polarity === "pass" ? field.options[0].id : field.options[1].id
  return undefined
}

/** Pass / fail of a natural pass/fail field's current answer; undefined for other fields. */
export function polarityOf(field: Field, answers: Answers | undefined): "pass" | "fail" | undefined {
  if (!isPassFail(field)) return undefined
  const value = answers?.[field.id]
  if (typeof value !== "string") return undefined
  const option = field.options?.find((entry) => entry.id === value)
  return option ? optionPolarity(option) : undefined
}

export function itemPolarity(fields: ReadonlyArray<Field>, answers: Answers | undefined): "pass" | "fail" | undefined {
  const field = visibleFields(fields, answers).find(isPassFail)
  return field ? polarityOf(field, answers) : undefined
}

/**
 * Keeps answers that match the schema and are visible given the other answers; clips text, drops
 * unknown ids and hidden fields. Undefined when nothing remains.
 */
export function sanitize(fields: ReadonlyArray<Field>, raw: unknown, maxText: number): Answers | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const input = raw as Record<string, unknown>
  const collected: Record<string, Answer> = {}
  for (const field of fields) {
    const value = input[field.id]
    if (field.type === "choice") {
      const ids = new Set((field.options ?? []).map((option) => option.id))
      if (typeof value === "string" && ids.has(value)) collected[field.id] = value
    } else if (field.type === "multi") {
      const ids = new Set((field.options ?? []).map((option) => option.id))
      if (!Array.isArray(value)) continue
      const picked = [...new Set(value.filter((entry): entry is string => typeof entry === "string" && ids.has(entry)))]
      if (picked.length > 0) collected[field.id] = picked
    } else if (typeof value === "string") {
      const text = value.trim().slice(0, maxText)
      if (text) collected[field.id] = text
    }
  }
  const result: Record<string, Answer> = {}
  for (const field of fields) {
    if (!visible(field, collected)) continue
    if (collected[field.id] !== undefined) result[field.id] = collected[field.id]
  }
  return Object.keys(result).length > 0 ? result : undefined
}

/** One line per answered visible field, using labels rather than ids. */
export function format(fields: ReadonlyArray<Field>, answers: Answers | undefined): string[] {
  if (!answers) return []
  const lines: string[] = []
  for (const field of fields) {
    if (!visible(field, answers)) continue
    const value = answers[field.id]
    if (value === undefined) continue
    if (field.type === "text" && typeof value === "string") {
      lines.push(`${field.label}: ${value.replaceAll("\n", "\n  ")}`)
    } else if (field.type === "choice" && typeof value === "string") {
      const label = field.options?.find((option) => option.id === value)?.label ?? value
      lines.push(`${field.label}: ${label}`)
    } else if (field.type === "multi" && Array.isArray(value)) {
      const labels = value.map((id) => field.options?.find((option) => option.id === id)?.label ?? id)
      if (labels.length > 0) lines.push(`${field.label}: ${labels.join("、")}`)
    }
  }
  return lines
}

/** Reports every problem in a form at once; used by `review_request` validation. */
export function validate(fields: ReadonlyArray<Field> | undefined, at: string): string[] {
  if (!fields) return []
  const errors: string[] = []
  if (fields.length > MAX_FIELDS) errors.push(`${at}.form: at most ${MAX_FIELDS} fields`)
  const ids = new Set<string>()
  fields.forEach((field, index) => {
    const where = `${at}.form[${index}]`
    if (!ID.test(field.id)) errors.push(`${where}.id must match [A-Za-z0-9_.-]{1,64}`)
    else if (ids.has(field.id)) errors.push(`${where}.id "${field.id}" is used twice`)
    ids.add(field.id)
    if (field.label.trim() === "") errors.push(`${where}.label is empty`)
    if (field.type === "choice" || field.type === "multi") {
      const options = field.options ?? []
      if (options.length === 0) errors.push(`${where}: ${field.type} needs options`)
      if (options.length > MAX_OPTIONS) errors.push(`${where}: at most ${MAX_OPTIONS} options`)
      const optionIDs = new Set<string>()
      options.forEach((option, optionIndex) => {
        const opt = `${where}.options[${optionIndex}]`
        if (!ID.test(option.id)) errors.push(`${opt}.id must match [A-Za-z0-9_.-]{1,64}`)
        else if (optionIDs.has(option.id)) errors.push(`${opt}.id "${option.id}" is used twice`)
        optionIDs.add(option.id)
        if (option.label.trim() === "") errors.push(`${opt}.label is empty`)
      })
    } else if ((field.options?.length ?? 0) > 0) errors.push(`${where}: text takes no options`)
    if (field.when) {
      if (field.when.field === field.id) errors.push(`${where}.when cannot refer to itself`)
      else if (!fields.some((other) => other.id === field.when!.field))
        errors.push(`${where}.when.field "${field.when.field}" does not exist`)
    }
  })
  return errors
}

/** A common pass / fail choice, for idle reviews and tests that need one. */
export function verdictChoice(required = true): Field {
  return {
    id: "verdict",
    type: "choice",
    label: "结论",
    ...(required ? { required: true } : {}),
    options: [
      { id: "pass", label: "通过" },
      { id: "fail", label: "不通过" },
    ],
  }
}

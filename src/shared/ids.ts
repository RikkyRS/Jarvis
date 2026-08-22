import { z } from "zod";

export const UuidSchema = z.string().uuid();
export const SlugSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const FriendlyNumberSchema = z.number().int().positive();

export const IdSchema = z.object({
  uuid: UuidSchema,
  number: FriendlyNumberSchema,
  slug: SlugSchema,
});

export type EntityId = z.infer<typeof IdSchema>;

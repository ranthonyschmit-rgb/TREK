import { createZodDto } from 'nestjs-zod';
import { assistantSendRequestSchema } from '@trek/shared';

/** Body DTO for POST /api/trips/:tripId/assistant/messages (validated by the global Zod pipe). */
export class AssistantSendDto extends createZodDto(assistantSendRequestSchema) {}

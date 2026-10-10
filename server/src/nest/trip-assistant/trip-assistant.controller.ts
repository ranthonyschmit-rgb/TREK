import { Body, Controller, Delete, Get, Headers, HttpCode, HttpException, Param, Post, UseGuards } from '@nestjs/common';
import type { AssistantConfigResponse, AssistantMessagesResponse, AssistantSendResponse, TripCurrenciesResponse } from '@trek/shared';
import type { User } from '../../types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission, TripAccessGuard } from '../permissions/trip-access.guard';
import { TripAssistantService } from './trip-assistant.service';
import { AssistantSendDto } from './trip-assistant.dto';

/**
 * /api/trips/:tripId/assistant — the shared AI trip assistant on the Collab
 * page (fork addition). Reading needs trip access; asking and clearing need
 * 'collab_edit', the same permission the rest of the Collab page uses.
 */
@Controller('api/trips/:tripId/assistant')
@UseGuards(JwtAuthGuard, TripAccessGuard)
export class TripAssistantController {
  constructor(private readonly assistant: TripAssistantService) {}

  @Get('config')
  config(): AssistantConfigResponse {
    return this.assistant.config();
  }

  @Get('messages')
  list(@Param('tripId') tripId: string): AssistantMessagesResponse {
    return { messages: this.assistant.list(tripId) };
  }

  @RequirePermission('collab_edit')
  @Post('messages')
  @HttpCode(200)
  async send(
    @CurrentUser() user: User,
    @Param('tripId') tripId: string,
    @Body() body: AssistantSendDto,
    @Headers('x-socket-id') socketId?: string,
  ): Promise<AssistantSendResponse> {
    const result = await this.assistant.send(tripId, user, body.text, body.model, socketId);
    if ('error' in result) {
      if (result.error === 'model_unavailable') {
        throw new HttpException({ error: 'That model is not set up on this server. Add its API key to the container settings.' }, 400);
      }
      throw new HttpException({ error: "You've asked a lot of questions in the last few minutes. Please wait a bit and try again." }, 429);
    }
    return { question: result.question, answer: result.answer };
  }

  @RequirePermission('collab_edit')
  @Delete('messages')
  clear(@Param('tripId') tripId: string, @Headers('x-socket-id') socketId?: string): { success: true } {
    this.assistant.clear(tripId, socketId);
    return { success: true };
  }
}

/** /api/trips/:tripId/currencies — currencies of the trip's destinations (fork addition). */
@Controller('api/trips/:tripId/currencies')
@UseGuards(JwtAuthGuard, TripAccessGuard)
export class TripCurrencyController {
  constructor(private readonly assistant: TripAssistantService) {}

  @Get()
  currencies(@Param('tripId') tripId: string): TripCurrenciesResponse {
    return this.assistant.currencies(tripId);
  }
}

import { Module } from '@nestjs/common';
import { TripAssistantController, TripCurrencyController } from './trip-assistant.controller';
import { TripAssistantService } from './trip-assistant.service';
import { AuthModule } from '../auth/auth.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { RateLimitModule } from '../common/rate-limit.module';

/** Fork addition: Collab-page AI trip assistant + per-trip currency lookup. Registered in AppModule. */
@Module({
  imports: [AuthModule, PermissionsModule, RealtimeModule, RateLimitModule],
  controllers: [TripAssistantController, TripCurrencyController],
  providers: [TripAssistantService],
})
export class TripAssistantModule {}

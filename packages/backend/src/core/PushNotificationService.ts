/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import push from 'web-push';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { Packed } from '@/misc/json-schema.js';
import { getNoteSummary } from '@/misc/get-note-summary.js';
import type { MiSwSubscription, SwSubscriptionsRepository } from '@/models/_.js';
import { MetaService } from '@/core/MetaService.js';
import { bindThis } from '@/decorators.js';
import { RedisKVCache } from '@/misc/cache.js';

import Logger from '@/logger.js';

// Defined also packages/sw/types.ts#L13
type PushNotificationsTypes = {
	'notification': Packed<'Notification'>;
	'unreadAntennaNote': {
		antenna: { id: string, name: string };
		note: Packed<'Note'>;
	};
	'readAllNotifications': undefined;
};

// Reduce length because push message servers have character limits
function truncateBody<T extends keyof PushNotificationsTypes>(type: T, body: PushNotificationsTypes[T]): PushNotificationsTypes[T] {
	if (typeof body !== 'object') return body;

	return {
		...body,
		...(('note' in body && body.note) ? {
			note: {
				...body.note,
				// textをgetNoteSummaryしたものに置き換える
				text: getNoteSummary(('type' in body && body.type === 'renote') ? body.note.renote as Packed<'Note'> : body.note),

				cw: undefined,
				reply: undefined,
				renote: undefined,
				user: type === 'notification' ? undefined as any : body.note.user,
			},
		} : {}),
	};
}

@Injectable()
export class PushNotificationService implements OnApplicationShutdown {
	private subscriptionsCache: RedisKVCache<MiSwSubscription[]>;
	private swLogger: Logger;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.swSubscriptionsRepository)
		private swSubscriptionsRepository: SwSubscriptionsRepository,

		private metaService: MetaService,
	) {
		this.subscriptionsCache = new RedisKVCache<MiSwSubscription[]>(this.redisClient, 'userSwSubscriptions', {
			lifetime: 1000 * 60 * 60 * 1, // 1h
			memoryCacheLifetime: 1000 * 60 * 3, // 3m
			fetcher: (key) => this.swSubscriptionsRepository.findBy({ userId: key }),
			toRedisConverter: (value) => JSON.stringify(value),
			fromRedisConverter: (value) => JSON.parse(value),
		});
		this.swLogger = new Logger('pushService');
	}

	@bindThis
	public async pushNotification<T extends keyof PushNotificationsTypes>(userId: string, type: T, body: PushNotificationsTypes[T]) {
		const meta = await this.metaService.fetch();

		if (!meta.enableServiceWorker || meta.swPublicKey == null || meta.swPrivateKey == null) return;

		// アプリケーションの連絡先と、サーバーサイドの鍵ペアの情報を登録
		push.setVapidDetails(this.config.url,
			meta.swPublicKey,
			meta.swPrivateKey);

		const subscriptions = await this.subscriptionsCache.fetch(userId);
		this.swLogger.info('start push Notification to' + userId);

		for (const subscription of subscriptions) {
			if ([
				'readAllNotifications',
			].includes(type) && !subscription.sendReadMessage) {
				this.swLogger.info('Skip readAllNotifications');
				continue;
			}

			const pushSubscription = {
				endpoint: subscription.endpoint,
				keys: {
					auth: subscription.auth,
					p256dh: subscription.publickey,
				},
			};

			this.swLogger.info('Sending push to Subscription: ' + JSON.stringify(pushSubscription));

			push.sendNotification(pushSubscription, JSON.stringify({
				type,
				body: (type === 'notification' || type === 'unreadAntennaNote') ? truncateBody(type, body) : body,
				userId,
				dateTime: (new Date()).getTime(),
			}), {
				proxy: this.config.proxy,
			}).catch((err: any) => {
				//swLogger.info(err.statusCode);
				//swLogger.info(err.headers);
				//swLogger.info(err.body);

				if (err.statusCode === 410) {
					this.swSubscriptionsRepository.delete({
						userId: userId,
						endpoint: subscription.endpoint,
						auth: subscription.auth,
						publickey: subscription.publickey,
					}).then(() => {
						this.refreshCache(userId);
					});
					this.swLogger.warn('Got 410, Delete swSubscription');
				} else {
					this.swLogger.warn('Error code' + err.statusCode);
					this.swLogger.warn(err.headers);
					this.swLogger.warn(err.body);
				}
			});
		}
	}

	@bindThis
	public refreshCache(userId: string): void {
		this.subscriptionsCache.refresh(userId);
	}

	@bindThis
	public dispose(): void {
		this.subscriptionsCache.dispose();
	}

	@bindThis
	public onApplicationShutdown(signal?: string | undefined): void {
		this.dispose();
	}
}

import {
  ActionRowBuilder,
  ButtonInteraction,
  CategoryChannel,
  MessageActionRowComponentBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ChannelType,
  OverwriteType,
  ComponentType,
  inlineCode,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';

import { ButtonComponent, Discord } from 'discordx';
import { injectable } from 'tsyringe';
import { EventActivity } from '../../feature/event/event-activity/event-activity.entity.js';
import { EventBan } from '../../feature/event/event-ban/event-ban.entity.js';
import { Event } from '../../feature/event/event.entity.js';
import { EventActivityService } from '../../feature/event/event-activity/event-activity.service.js';
import { Eventsmode } from '../../feature/eventsmode/eventsmode.entity.js';
import { Guild } from '../../feature/guild/guild.entity.js';
import { BotMessages, Colors } from '../../lib/constants.js';
import { embedResponse } from '../../lib/embed-response.js';
import { CommandError } from '../../lib/errors/command.error.js';
import { userWithMentionAndId } from '../../lib/log-formatter.js';
import { logger } from '../../lib/logger.js';
import { permissionForChannels } from '../../lib/permission-for-channels.js';
import { safeJsonParse } from '../../lib/safe-json-parse.js';

@Discord()
@injectable()
export class Button {
  constructor(private readonly eventActivityService: EventActivityService) {}

  @ButtonComponent({ id: '@action/start-event' })
  async startEventAction(ctx: ButtonInteraction<'cached'>) {
    await ctx.deferReply({ ephemeral: true });

    const guild = await Guild.findOne({
      where: { id: ctx.guild.id },
      relations: { globalEventBans: true, settingsManagement: true },
    });

    const eventsmode = await Eventsmode.findOneBy({
      userId: ctx.member.id,
      guild: { id: ctx.guild.id },
      isHired: true,
    });

    if (!eventsmode) {
      throw new CommandError({
        ctx,
        content: embedResponse({
          template: BotMessages.EVENTSMODE_NOT_EXISTS,
          status: Colors.DANGER,
          ephemeral: true,
        }),
      });
    }

    const eventActivity = await EventActivity.findOneBy({
      executor: { userId: ctx.member.id, guild: { id: ctx.guild.id } },
      guild: { id: ctx.guild.id },
    });

    if (eventActivity) {
      throw new CommandError({
        ctx,
        content: embedResponse({
          template: 'You already have an active event going on.',
          status: Colors.DANGER,
          ephemeral: true,
        }),
      });
    }

    const allEvents = await Event.find({
      where: { guild: { id: ctx.guild.id } },
    });

    if (!allEvents.length) {
      throw new CommandError({
        ctx,
        content: embedResponse({
          template: BotMessages.EVENT_LIST_EMPTY,
          status: Colors.DANGER,
          ephemeral: true,
        }),
      });
    }

    const allCategory = [...new Set(allEvents.map(({ category }) => category))];

    const categorySelectMenuRow =
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('@select/choose-event-category')
          .setPlaceholder('Choose event category')
          .addOptions(
            allCategory.map((value) => {
              return { label: value, value };
            }),
          ),
      );

    const categorySelectMessage = await ctx.followUp({
      components: [categorySelectMenuRow],
      ephemeral: true,
    });

    const categorySelectCollector = categorySelectMessage.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      time: 15_000,
    });

    categorySelectCollector.once(
      'collect',
      async (categorySelectMenuCtx: StringSelectMenuInteraction<'cached'>) => {
        await categorySelectMenuCtx.deferReply({ ephemeral: true });

        const eventCategory = categorySelectMenuCtx.values[0];

        const eventSelectMenuRow =
          new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('@select/choose-event')
              .setPlaceholder('Choose event by name')
              .addOptions(
                allEvents
                  .filter((event) => event.category === eventCategory)
                  .map(({ name }) => {
                    return { label: name, value: name };
                  }),
              ),
          );

        const eventSelectMessage = await categorySelectMenuCtx.editReply({
          components: [eventSelectMenuRow],
        });

        const eventSelectCollector = eventSelectMessage.createMessageComponentCollector({
          componentType: ComponentType.StringSelect,
          time: 15_000,
        });

        eventSelectCollector.once(
          'collect',
          async (eventSelectMenuCtx: StringSelectMenuInteraction<'cached'>) => {
            await eventSelectMenuCtx.deferReply({ ephemeral: true });

            const event = await Event.findOneBy({
              guild: { id: ctx.guild.id },
              category: eventCategory,
              name: eventSelectMenuCtx.values[0],
            });

            if (!event) {
              throw new CommandError({
                ctx: eventSelectMenuCtx,
                content: embedResponse({
                  template: BotMessages.SOMETHING_GONE_WRONG,
                  status: Colors.DANGER,
                  ephemeral: true,
                }),
              });
            }

            const { isChannelConfigured, eventsmodeCategoryId } = guild!.settingsManagement;

            if (!isChannelConfigured) {
              throw new CommandError({
                ctx: eventSelectMenuCtx,
                content: embedResponse({
                  template: 'channel is not configured',
                  status: Colors.DANGER,
                  ephemeral: true,
                }),
              });
            }

            const eventCategoryChannel = eventSelectMenuCtx.guild.channels.cache.get(
              eventsmodeCategoryId,
            ) as CategoryChannel | undefined;

            if (!eventCategoryChannel) {
              throw new CommandError({
                ctx: eventSelectMenuCtx,
                content: embedResponse({
                  template: 'bot cant fetch channel :((',
                  status: Colors.DANGER,
                  ephemeral: true,
                }),
              });
            }

            const eventBans = await EventBan.findBy({
              executor: { userId: ctx.user.id, guild: { id: ctx.guild.id } },
              guild: { id: ctx.guild.id },
            });

            const eventVoiceChannelRaw = await eventCategoryChannel.children.create({
              name: event.name,
              userLimit: 10,
              type: ChannelType.GuildVoice,
              position: 0,
            });

            const eventTextChannelRaw = await eventCategoryChannel.children.create({
              name: event.name,
              type: ChannelType.GuildText,
            });

            const eventVoiceChannel = await eventVoiceChannelRaw.lockPermissions();
            const eventTextChannel = await eventTextChannelRaw.lockPermissions();

            if (eventBans.length) {
              for (const { target } of eventBans) {
                await permissionForChannels(
                  [eventVoiceChannel, eventTextChannel],
                  target.userId,
                  {
                    Speak: false,
                    Connect: false,
                    SendMessages: false,
                  },
                  { type: OverwriteType.Member },
                );
              }
            }

            const { globalEventBans, settingsManagement } = guild!;

            if (globalEventBans.length) {
              for (const { target } of globalEventBans) {
                await permissionForChannels(
                  [eventVoiceChannel, eventTextChannel],
                  target.userId,
                  {
                    Speak: false,
                    Connect: false,
                    SendMessages: false,
                  },
                  { type: OverwriteType.Member },
                );
              }
            }

            await permissionForChannels(
              [eventVoiceChannel, eventTextChannel],
              eventSelectMenuCtx.user.id,
              {
                ManageRoles: true,
                ManageChannels: true,
                SendMessages: true,
                ViewChannel: true,
              },
              { type: OverwriteType.Member },
            );

            // await permissionForChannels(
            //   [eventTextChannel],
            //   ctx.guild.roles.everyone,
            //   { SendMessages: false },
            //   { type: OverwriteType.Role },
            // );

            await this.eventActivityService.createEventActivity({
              guildId: eventSelectMenuCtx.guild.id,
              event,
              eventsmode,
              voiceChannelId: eventVoiceChannel.id,
              textChannelId: eventTextChannel.id,
            });

            await eventSelectMenuCtx.editReply({
              content: 'Ивент был успешно создан!',
              components: [],
            });

            if (ctx.guild.id === '457902248660434944') {
              const recruitEmbed = new EmbedBuilder()
              .setTitle(`<a:1905carebearblue:977344103006236792> Открыт набор на Eventsmod`)
              .setDescription(
                `<a:assiki2:1155562343841939587> **Ивентерики** - это люди которые проводят ивентики и глобальные мероприятия. У нас ты сможешь играть в свои любимые игры а так же найти друзей. У нас есть печеньки и чай так что тебя не обидем.
                <a:assiki2:1155562343841939587> Если тебя заинтересовало то подавай заявку на кнопочку ниже или же если возникли вопросы то в лс <@684837635751018520>`,
              )
              .setImage('https://i.pinimg.com/736x/4f/d3/38/4fd3380d745bb2c08ba76e01be0650ce.jpg')
              .setColor(14921983);

              const row = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
                new ButtonBuilder()
                  .setLabel('Подать заявку')
                  .setStyle(ButtonStyle.Link)
                  .setURL(
                    `https://discord.com/channels/457902248660434944/994392141197475870/1171859955171737680`,
                  ),
              );

              await eventTextChannel.send({
                embeds: [recruitEmbed],
                components: [row],
              });
            }

            await eventTextChannel
              .send(
                embedResponse({
                  template: '$1 запустил ивент $2',
                  replaceArgs: [userWithMentionAndId(ctx.user.id), inlineCode(event.name)],
                }),
              )
              .then(async (msg) => await msg.pin())
              .catch(logger.error);

            await eventTextChannel
              .send(safeJsonParse(event.startEmbed, { content: BotMessages.SOMETHING_GONE_WRONG }))
              .then(async (msg) => await msg.pin())
              .catch(logger.error);

              if (settingsManagement.isEventAnnounce) {
                if (!settingsManagement.announceEventChannelId) {
                  throw new CommandError({
                    ctx,
                    content: embedResponse({
                      template: 'Please contact your moderator/administrator to setup announce channel',
                      status: Colors.DANGER,
                      ephemeral: true,
                    }),
                  });
                }
          
                const eventAnnounceChannel = ctx.guild.channels.cache.get(
                  settingsManagement.announceEventChannelId,
                );
          
                if (eventAnnounceChannel && eventAnnounceChannel.isTextBased()) {
                  const linkButton = new ButtonBuilder()
                    .setLabel('Присоединиться')
                    .setStyle(ButtonStyle.Link)
                    .setURL(`https://discord.com/channels/${ctx.guild.id}/${eventVoiceChannel.id}`);
                
                  const row = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(linkButton);
                  
                  const embed = safeJsonParse(event.announcedEmbed, {
                    content: BotMessages.SOMETHING_GONE_WRONG,
                  });
            
                  await eventAnnounceChannel
                    .send({ ...embed, components: [row] })
                    .catch(logger.error);
                }
              }
          },
        );
      },
    );
  }
}

import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  bold,
  codeBlock,
  CommandInteraction,
  EmbedBuilder,
  GuildMember,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
  time,
} from 'discord.js';
import {
  Discord,
  Guard,
  ModalComponent,
  Slash,
  SlashGroup,
  SlashOption,
  SlashChoice,
} from 'discordx';
import { injectable } from 'tsyringe';
import { EventService } from '../../feature/event/event.service.js';
import { LoggerService } from '../../feature/guild/guild-logger.service.js';
import { Event } from '../../feature/event/event.entity.js';
import { ModeratorGuard } from '../../guards/moderator.guard.js';
import { BotMessages, Colors } from '../../lib/constants.js';
import { embedResponse } from '../../lib/embed-response.js';
import { CommandError } from '../../lib/errors/command.error.js';
import { userWithNameAndId } from '../../lib/log-formatter.js';
import { chunks, pagination } from '../../lib/pagination.js';
import { EventActivity } from '../../feature/event/event-activity/event-activity.entity.js';
import { logger } from '../../lib/logger.js';
import { EventActivityService } from '../../feature/event/event-activity/event-activity.service.js';
import { EventsmodeService } from '../../feature/eventsmode/eventsmode.service.js';
import { WeeklyEventHistoryService } from '../../feature/event/weekly-event-history/weekly-event-history.service.js';
import { GlobalEventHistoryService } from '../../feature/event/global-event-history/global-event-history.service.js';

@Discord()
@injectable()
@Guard(ModeratorGuard)
@SlashGroup({ description: 'Manage event', name: 'event' })
export class Command {
  constructor(
    private readonly eventService: EventService,
    private readonly loggerService: LoggerService,
    private readonly eventActivityService: EventActivityService,
    private readonly eventsmodeService: EventsmodeService,
    private readonly weeklyEventHistoryService: WeeklyEventHistoryService,
    private readonly globalEventHistoryService: GlobalEventHistoryService,
  ) {}

  @SlashGroup('event')
  @Slash({ description: 'Add new event' })
  async add(ctx: CommandInteraction<'cached'>) {
    const modal = new ModalBuilder()
      .setTitle('Create event')
      .setCustomId('@modal/create-event-action');

    const rows = [
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('@modal/field-event-name')
          .setLabel('Provide event name')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(20),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('@modal/field-event-category')
          .setLabel('Provide event category name')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(20),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('@modal/field-event-multiplayer')
          .setLabel('Provide event multiplayer (exp. 0.30, 0.80)')
          .setStyle(TextInputStyle.Short),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('@modal/field-event-start-embed')
          .setLabel('Provide start embed text')
          .setStyle(TextInputStyle.Paragraph),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('@modal/field-event-announce-embed')
          .setLabel('Provide announce embed text')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false),
      ),
    ];

    modal.addComponents(rows);
    await ctx.showModal(modal);
  }

  @ModalComponent({ id: '@modal/create-event-action' })
  async createEventModalHandler(ctx: ModalSubmitInteraction<'cached'>) {
    const [eventName, eventCategory, eventMultiplayer, eventStartEmbed, eventAnnounceEmbed] = [
      '@modal/field-event-name',
      '@modal/field-event-category',
      '@modal/field-event-multiplayer',
      '@modal/field-event-start-embed',
      '@modal/field-event-announce-embed',
    ].map((id) => ctx.fields.getTextInputValue(id));

    const event = await Event.findOneBy({
      name: eventName,
      category: eventCategory,
      guild: { id: ctx.guild.id },
    });

    if (event) {
      throw new CommandError({
        ctx,
        content: embedResponse({
          template: `Event with name ${bold(eventName)} already exists.`,
          status: Colors.DANGER,
          ephemeral: true,
        }),
      });
    }

    await this.eventService.createEvent({
      guildId: ctx.guild.id,
      eventName,
      eventCategory,
      eventMultiplayer: parseFloat(eventMultiplayer),
      eventStartEmbed,
      eventAnnounceEmbed,
    });

    await this.loggerService.log({
      guildId: ctx.guild.id,
      bot: ctx.client,
      message: embedResponse({
        template: `$1 добавил новый ивент $2`,
        replaceArgs: [
          userWithNameAndId(ctx.user),
          codeBlock(
            `Name: ${eventName}\nCategory: ${eventCategory}\nMultiplayer: ${eventMultiplayer}`,
          ),
        ],
      }),
    });

    await ctx.reply(
      embedResponse({
        template: `Ивент был успешно добавлен!`,
        status: Colors.SUCCESS,
        ephemeral: true,
      }),
    );
    return;
  }

  @SlashGroup('event')
  @Slash({ description: 'List of all events' })
  async list(ctx: CommandInteraction<'cached'>) {
    await ctx.deferReply({ ephemeral: true });

    const events = await Event.find({
      where: { guild: { id: ctx.guild.id } },
      order: { category: 'ASC' },
    });

    if (events.length === 0) {
      throw new CommandError({
        ctx,
        content: embedResponse({ template: BotMessages.EVENT_LIST_EMPTY, ephemeral: true }),
      });
    }

    const textChunks = chunks(
      events.map(
        ({ name, category, multiplayer }, index) =>
          `${index + 1}. ${name} | ${category} | ${multiplayer}`,
      ),
      25,
    );

    const embeds = textChunks.map((textArray) => {
      const embed = new EmbedBuilder();
      embed.setColor(Colors.INFO);
      embed.setDescription(textArray.join('\n'));
      return embed;
    });

    return pagination(ctx, embeds);
  }

  @SlashGroup('event')
  @Slash({ description: 'Edit event certain field' })
  async edit(
    @SlashOption({
      description: 'event name',
      name: 'name',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
      name: string,
    @SlashOption({
      description: 'event category',
      name: 'category',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    category: string,
    @SlashChoice('name', 'category', 'multiplayer', 'startEmbed', 'announcedEmbed')
    @SlashOption({
      description: 'Choice field tha you wanna change',
      name: 'field',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    field: string,
    @SlashOption({
      description: 'Value that will be replaced',
      name: 'value',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    value: string,

    ctx: CommandInteraction<'cached'>,
  ) {
    const event = await Event.findOneBy({ name, category, guild: { id: ctx.guild.id } });

    if (!event) {
      throw new CommandError({
        ctx,
        content: embedResponse({
          template: BotMessages.EVENT_NOT_EXISTS,
          status: Colors.DANGER,
          ephemeral: true,
        }),
      });
    }

    await this.eventService.updateEvent(
      ctx.guild.id,
      event.id,
      field,
      Number.isNaN(parseFloat(value)) ? value : parseFloat(value),
    );

    const template: string = `$1 изменил поле $2 на $3 ивента $4`;

    await this.loggerService.log({
      guildId: ctx.guild.id,
      bot: ctx.client,
      message: embedResponse({
        template: template,
        replaceArgs: [userWithNameAndId(ctx.user), bold(field), bold(value), `${name}|${category}`],
      }),
    });

    await ctx.reply(
      embedResponse({
        template: `Вы изменил поле $1 на $2 ивента $3`,
        replaceArgs: [bold(field), bold(value), `${name}|${category}`],
        status: Colors.SUCCESS,
        ephemeral: true,
      }),
    );
  }

  @SlashGroup('event')
  @Slash({ description: 'Remove event from event list' })
  async remove(
    @SlashOption({
      description: 'event name',
      name: 'name',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    name: string,
    @SlashOption({
      description: 'event category',
      name: 'category',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    category: string,
    ctx: CommandInteraction<'cached'>,
  ) {
    const event = await Event.findOneBy({ name, category, guild: { id: ctx.guild.id } });

    if (!event) {
      throw new CommandError({
        ctx,
        content: embedResponse({
          template: BotMessages.EVENTSMODE_NOT_EXISTS,
          status: Colors.DANGER,
          ephemeral: true,
        }),
      });
    }

    await this.eventService.removeEvent(ctx.guild.id, name, category);
    await ctx.reply({ content: 'Event was successfully deleted.', ephemeral: true });
  }

  @SlashGroup('event')
  @Slash({ description: 'Forced event close for eventsmode' })
  async close(
    @SlashOption({
      description: 'user',
      name: 'user',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    member: GuildMember,
    ctx: CommandInteraction<'cached'>,
  ) {
    const eventActivity = await EventActivity.findOneBy({
      executor: { userId: member.user.id, guild: { id: member.guild.id } },
    });

    if (!eventActivity) {
      throw new CommandError({
        ctx,
        content: embedResponse({
          template: `Пользователь не ведет никакой ивент.`,
          status: Colors.DANGER,
          ephemeral: true,
        }),
      });
    }

    const { id, event, voiceChannelId, textChannelId, executor, startedAt, eventTime } =
      eventActivity!;

    await this.eventActivityService.deleteEventActivity(id);

    const salary = ~~(eventTime * event.multiplayer);

    await this.eventsmodeService.editStatistics(executor.userId, executor.guild.id, {
      weeklySalary: salary,
      totalSalary: salary,
    });

    if (executor.longestEvent === 0 || eventTime > executor.longestEvent) {
      await this.eventsmodeService.editStatistics(executor.userId, executor.guild.id, {
        longestEvent: eventTime,
      });
    }

    await this.weeklyEventHistoryService.addWeeklyEventHistory({
      guild: { id: ctx.guild.id },
      event,
      eventsmode: executor,
      startedAt,
      totalTime: eventTime,
      totalSalary: salary,
    });

    await this.globalEventHistoryService.addGlobalEventHistory({
      guild: { id: ctx.guild.id },
      event,
      eventsmode: executor,
      startedAt,
      totalTime: eventTime,
      totalSalary: salary,
    });

    await ctx.guild.channels.delete(voiceChannelId).catch(logger.error);
    await ctx.guild.channels.delete(textChannelId).catch(logger.error);

    await this.loggerService.log({
      guildId: ctx.guild.id,
      bot: ctx.client,
      message: embedResponse({
        template: `$1 закочил ивент $2 в $3\n$4`,
        replaceArgs: [
          userWithNameAndId(ctx.user),
          event.category + ' | ' + event.name,
          time(~~(new Date().getTime() / 1000)),
          codeBlock('ts', `Время Ивентов: ${eventTime}\nЗарплата: ${salary}`),
        ],
      }),
    });

    await ctx.editReply({ content: 'done' });
  }
}

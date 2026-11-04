{
    name: 'pnc.danger_sign_followup_baby.from_report',
    icon: 'icon-follow-up',
    title: 'task.pnc.danger_sign_followup_baby.title',
    appliesTo: 'reports',
    appliesToType: ['pnc_danger_sign_follow_up_baby'],
    appliesIf: function (contact, report) {
      return (
        getField(report, 't_danger_signs_referral_follow_up') === 'yes' &&
        isAlive(contact)
      );
    },
    resolvedIf: function (contact, report, event, dueDate) {
      //(refused or migrated) and cleared tasks
      if (isPregnancyTaskMuted(contact)) {
        return true;
      }
      const startTime = Math.max(
        addDays(dueDate, -event.start).getTime(),
        report.reported_date + 1
      );
      //reported_date + 1 so that source ds_follow_up does not resolve itself
      const endTime = addDays(dueDate, event.end + 1).getTime();
      return isFormArraySubmittedInWindow(
        contact.reports,
        ['pnc_danger_sign_follow_up_baby'],
        startTime,
        endTime
      );
    },
    priority: function () {
      return {
        level: 10,
        label: 'High',
      };
    },
    actions: [
      {
        type: 'report',
        form: 'pnc_danger_sign_follow_up_baby',
        modifyContent: function (content, contact, report) {
          content.delivery_uuid = getField(report, 'inputs.delivery_uuid');
        },
      },
    ],
    events: [
      {
        id: 'pnc-danger-sign-follow-up-baby',
        start: 3,
        end: 7,
        dueDate: function (event, contact, report) {
          return getDateISOLocal(
            getField(report, 't_danger_signs_referral_follow_up_date')
          );
        },
      },
    ],
  }

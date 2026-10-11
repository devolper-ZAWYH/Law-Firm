-- ---------------------------------------------------------------------------
-- RANDOM BILINGUAL (EN/AR) TEST DATA — for local/dev use only, not real data.
--
-- Assumes all prior migrations have run (companies + the employee/manager
-- roster from seed_platform.sql already exist). For each company, this
-- creates 4 CRM contacts, 6 folders (mix of case/contract, mix of
-- potential/active/expired sections), 2 tasks per folder in varied statuses
-- (open/awaiting_approval/approved) with matching task_events history, and a
-- couple of notifications. All fictional — no real client/case names.
--
-- Idempotent-ish: marks its own folders with drive_link = 'seed:random-test-data'
-- and skips a company that already has them, so re-running is harmless.
-- ---------------------------------------------------------------------------

do $$
declare
  comp record;
  members uuid[];
  manager_id uuid;
  contact_ids uuid[] := '{}';
  contact_names_ar text[] := '{}';
  contact_names_en text[] := '{}';
  new_contact_id uuid;
  new_file_id uuid;
  new_task_id uuid;
  assignee_id uuid;
  approver_id uuid;
  i int;
  k int;
  cidx int;
  oidx int;
  tidx int;
  ftype text;
  fsection text;
  tstatus text;
  client_pairs text[][] := array[
    array['شركة الخليج للمقاولات','Gulf Coast Contracting Co.'],
    array['مجموعة النخبة التجارية','Al Nukhba Trading Group'],
    array['أحمد بن راشد المهندي','Ahmed bin Rashid Al-Muhannadi'],
    array['مؤسسة ألفا للاستشارات','Alfa Consultancy Est.'],
    array['سارة عبدالعزيز النعيمي','Sara Abdulaziz Al-Naimi'],
    array['شركة درة الخليج العقارية','Durrat Al-Khaleej Real Estate Co.'],
    array['خالد يوسف السليطي','Khalid Yousef Al-Sulaiti'],
    array['مؤسسة النور للمقاولات','Al-Noor Contracting Est.']
  ];
  opponent_pairs text[][] := array[
    array['بنك قطر التجاري','Qatar Commercial Bank'],
    array['شركة الفنار للتأمين','Al-Fanar Insurance Co.'],
    array['مجموعة الوسيط للشحن','Al-Waseet Shipping Group'],
    array['فاطمة سالم الكواري','Fatima Salem Al-Kuwari'],
    array['شركة المرجان للتجارة','Al-Murjan Trading Co.'],
    array['يوسف إبراهيم الأنصاري','Yousef Ibrahim Al-Ansari']
  ];
  task_titles text[][] := array[
    array['مراجعة العقد الأولي','Initial contract review'],
    array['تحضير مذكرة الرد','Prepare response memo'],
    array['متابعة جلسة المحكمة','Follow up court hearing'],
    array['جمع المستندات المطلوبة','Collect required documents'],
    array['صياغة إشعار قانوني','Draft legal notice'],
    array['مراجعة أدلة القضية','Review case evidence'],
    array['تحديث ملف العميل','Update client file'],
    array['التواصل مع الطرف الآخر','Contact opposing party']
  ];
  statuses text[] := array['open','awaiting_approval','approved'];
begin
  for comp in select id from companies loop

    if exists (select 1 from files where company_id = comp.id and drive_link = 'seed:random-test-data') then
      continue;
    end if;

    select array_agg(user_id) into members from memberships where company_id = comp.id;
    if members is null or array_length(members,1) is null then
      continue;
    end if;

    select user_id into manager_id from memberships where company_id = comp.id and role = 'manager' limit 1;
    if manager_id is null then
      manager_id := members[1];
    end if;

    contact_ids := '{}';
    contact_names_ar := '{}';
    contact_names_en := '{}';

    for i in 1..4 loop
      cidx := 1 + floor(random() * array_length(client_pairs,1))::int;
      insert into contacts (
        company_id, name, name_ar, name_en, phone, phone_country_code,
        email, notes, notes_ar, notes_en, created_by
      ) values (
        comp.id,
        client_pairs[cidx][1],
        client_pairs[cidx][1],
        client_pairs[cidx][2],
        '5' || lpad(floor(random()*9999999)::text, 7, '0'),
        '+974',
        'client' || i || '.' || replace(comp.id::text, '-', '') || '@example.qa',
        'عميل تجريبي لأغراض الاختبار المحلي',
        'عميل تجريبي لأغراض الاختبار المحلي',
        'Test client for local development',
        manager_id
      )
      returning id into new_contact_id;
      contact_ids := array_append(contact_ids, new_contact_id);
      contact_names_ar := array_append(contact_names_ar, client_pairs[cidx][1]);
      contact_names_en := array_append(contact_names_en, client_pairs[cidx][2]);
    end loop;

    for i in 1..6 loop
      ftype := (array['case','case','case','contract'])[1 + floor(random()*4)::int];
      fsection := (array['potential','active','active','expired'])[1 + floor(random()*4)::int];
      cidx := 1 + floor(random() * array_length(contact_ids,1))::int;
      oidx := 1 + floor(random() * array_length(opponent_pairs,1))::int;

      insert into files (
        company_id, client, opponent, managing_lawyer, drive_link, section,
        created_by, folder_type, client_contact_id, opponent_en, opponent_ar, folder_leader_id
      ) values (
        comp.id,
        contact_names_ar[cidx],
        case when ftype = 'case' then opponent_pairs[oidx][1] else '' end,
        (select coalesce(full_name_ar, full_name_en, username) from app_users where id = manager_id),
        'seed:random-test-data',
        fsection,
        manager_id,
        ftype,
        contact_ids[cidx],
        case when ftype = 'case' then opponent_pairs[oidx][2] else null end,
        case when ftype = 'case' then opponent_pairs[oidx][1] else null end,
        members[1 + floor(random()*array_length(members,1))::int]
      )
      returning id into new_file_id;

      for k in 1..2 loop
        assignee_id := members[1 + floor(random()*array_length(members,1))::int];
        approver_id := manager_id;
        if assignee_id = approver_id and array_length(members,1) > 1 then
          approver_id := members[1 + floor(random()*array_length(members,1))::int];
        end if;
        tstatus := statuses[1 + floor(random()*array_length(statuses,1))::int];
        tidx := 1 + floor(random()*array_length(task_titles,1))::int;

        insert into tasks (
          file_id, title, description, assignee_id, approver_id, created_by,
          status, assigned_at, accumulated_working_seconds, last_resumed_at
        ) values (
          new_file_id,
          task_titles[tidx][1] || ' / ' || task_titles[tidx][2],
          'مهمة تجريبية لأغراض الاختبار المحلي - Test task for local development',
          assignee_id,
          approver_id,
          manager_id,
          tstatus::task_status,
          now() - (floor(random()*10)::text || ' days')::interval,
          floor(random()*200000)::bigint,
          case when tstatus = 'open' then now() - (floor(random()*3)::text || ' days')::interval else null end
        )
        returning id into new_task_id;

        insert into task_events (task_id, type, actor_id, note)
        values (new_task_id, 'created', manager_id, null);

        if tstatus in ('awaiting_approval','approved') then
          insert into task_events (task_id, type, actor_id, note)
          values (new_task_id, 'marked_done', assignee_id, 'تم الانتهاء من المهمة - Done');
        end if;
        if tstatus = 'approved' then
          insert into task_events (task_id, type, actor_id, note)
          values (new_task_id, 'approved', approver_id, null);
        end if;

        insert into file_access (file_id, user_id) values (new_file_id, assignee_id)
        on conflict do nothing;
      end loop;
    end loop;

    insert into notifications (user_id, company_id, type, level, message_en, message_ar, is_read)
    values
      (manager_id, comp.id, 'overdue_warn', 'warn', 'A task is approaching its deadline', 'مهمة تقترب من موعدها النهائي', false),
      (manager_id, comp.id, 'task_done', null, 'An employee marked a task done', 'قام موظف بإنهاء مهمة', false);

  end loop;
end
$$;

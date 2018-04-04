    async update${objName}s(root, args, context, ast) {
      let db = await root.db;
      let { $match, $project } = decontructGraphqlQuery({ _id_in: args._ids }, ast, ${objName}Metadata, "${objName}s");
      let updates = await getUpdateObject(args.Updates || {}, ${objName}Metadata, { db, dbHelpers });

      if (await processHook(hooksObj, "${objName}", "beforeUpdate", $match, updates, root, args, context, ast) === false) {
        return { success: true };
      }
      await dbHelpers.runUpdate(db, "${table}", $match, updates, { multi: true });
      await processHook(hooksObj, "${objName}", "afterUpdate", $match, updates, root, args, context, ast);
      
      let result = $project ? await load${objName}s(db, { $match, $project }) : null;
      return {
        ${objName}s: result,
        success: true
      };
    }
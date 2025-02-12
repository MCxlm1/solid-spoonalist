import { world, system } from "@minecraft/server";

// 存储世界状态的对象
let worldState = null;

// 添加一个简单的延迟函数
function delay(ticks) {
    return new Promise(resolve => {
        system.runTimeout(() => {
            resolve();
        }, ticks);
    });
}

// 记录世界状态的函数
function recordWorldState(player) {
    try {
        const dimension = player.dimension;
        worldState = {
            dayCount: Math.floor(world.getTimeOfDay() / 24000), // 获取游戏天数
            timeOfDay: world.getTimeOfDay() % 24000, // 获取一天中的时间（0-24000）
            entities: [],
            blocks: []
        };

        // 记录生物信息并添加标签
        const entities = dimension.getEntities();
        for (const entity of entities) {
            // 跳过玩家实体和掉落物
            if (entity.typeId === "minecraft:player" || entity.typeId === "minecraft:item") continue;
            
            // 给实体添加标签以标记它在记录时存在
            try {
                player.runCommandAsync(`tag @e[type=${entity.typeId},x=${Math.floor(entity.location.x)},y=${Math.floor(entity.location.y)},z=${Math.floor(entity.location.z)},r=1] add recorded_entity`);
            } catch (error) {
                console.warn(`添加实体标签时出错: ${error}`);
            }
            
            // 记录生物的类型、位置和血量
            worldState.entities.push({
                type: entity.typeId,
                location: {
                    x: Math.floor(entity.location.x),
                    y: Math.floor(entity.location.y),
                    z: Math.floor(entity.location.z)
                },
                health: entity.getComponent("health")?.currentValue ?? 0
            });
        }

        // 记录玩家周围13x13x13范围内的方块
        const pos = player.location;
        const range = 6;  // 改为6，因为是以玩家为中心向两边延伸6格，总共13格

        // 获取世界的高度限制
        const minY = dimension.heightRange.min;
        const maxY = dimension.heightRange.max;

        for (let x = -range; x <= range; x++) {
            for (let y = -range; y <= range; y++) {
                for (let z = -range; z <= range; z++) {
                    const blockPos = {
                        x: Math.floor(pos.x + x),
                        y: Math.floor(pos.y + y),
                        z: Math.floor(pos.z + z)
                    };
                    
                    // 检查Y坐标是否在世界高度范围内
                    if (blockPos.y < minY || blockPos.y > maxY) {
                        continue;
                    }
                    
                    try {
                        const block = dimension.getBlock(blockPos);
                        // 记录所有方块，包括空气
                        if (block) {
                            worldState.blocks.push({
                                type: block.typeId,
                                location: blockPos
                            });
                        }
                    } catch (error) {
                        // 忽略边界错误，继续检查下一个方块
                        continue;
                    }
                }
            }
        }

        // 向玩家发送记录成功的消息
        player.sendMessage("§a世界状态记录成功！");
        
        // 在控制台输出记录的信息
        console.warn("=== 世界状态记录 ===");
        console.warn(`游戏天数: ${worldState.dayCount}`);
        console.warn(`当天时间: ${worldState.timeOfDay}`);
        console.warn(`记录的生物数量: ${worldState.entities.length}`);
        console.warn(`记录的方块数量: ${worldState.blocks.length}`);
        
    } catch (error) {
        console.warn("记录世界状态时出错：" + error);
        player.sendMessage("§c记录世界状态失败！");
    }
}

// 还原实体的函数
async function restoreEntities(player, dimension) {
    player.sendMessage("§e正在还原实体...");
    
    // 首先清除所有没有标签的非玩家非物品实体（这些是记录后新出现的）
    try {
        await player.runCommandAsync(`kill @e[type=!player,type=!item,tag=!recorded_entity]`);
    } catch (error) {
        console.warn(`清除未记录实体时出错: ${error}`);
    }

    // 给已使用的实体添加临时标签，避免重复使用
    const TEMP_TAG = "being_restored";
    
    // 处理记录的实体
    for (const recordedEntity of worldState.entities) {
        try {
            let entityRestored = false;
            const { x, y, z } = recordedEntity.location;
            
            // 先尝试在原位置找实体
            try {
                const exactCheckCmd = `testfor @e[type=${recordedEntity.type},x=${x},y=${y},z=${z},r=1,tag=recorded_entity,tag=!${TEMP_TAG}]`;
                await player.runCommandAsync(exactCheckCmd);
                
                // 如果在原位置找到了实体，给它添加临时标签
                await player.runCommandAsync(`tag @e[type=${recordedEntity.type},x=${x},y=${y},z=${z},r=1,tag=recorded_entity,tag=!${TEMP_TAG},c=1] add ${TEMP_TAG}`);
                entityRestored = true;
                console.warn(`使用原位置实体: ${recordedEntity.type} at (${x}, ${y}, ${z})`);
            } catch {
                // 如果原位置没找到，尝试在周围找
                try {
                    const nearbyCheckCmd = `testfor @e[type=${recordedEntity.type},x=${x},y=${y},z=${z},r=10,tag=recorded_entity,tag=!${TEMP_TAG}]`;
                    await player.runCommandAsync(nearbyCheckCmd);
                    
                    // 如果在周围找到了实体，将其传送到准确位置并标记
                    await player.runCommandAsync(`tp @e[type=${recordedEntity.type},x=${x},y=${y},z=${z},r=10,tag=recorded_entity,tag=!${TEMP_TAG},c=1] ${x} ${y} ${z}`);
                    await player.runCommandAsync(`tag @e[type=${recordedEntity.type},x=${x},y=${y},z=${z},r=1,tag=recorded_entity,tag=!${TEMP_TAG},c=1] add ${TEMP_TAG}`);
                    entityRestored = true;
                    console.warn(`传送附近实体: ${recordedEntity.type} to (${x}, ${y}, ${z})`);
                } catch {
                    entityRestored = false;
                }
            }

            // 如果实体没有被还原，生成新的
            if (!entityRestored) {
                try {
                    // 生成新实体并等待
                    await player.runCommandAsync(`summon ${recordedEntity.type} ${x} ${y} ${z}`);
                    await delay(2);  // 增加延迟确保实体生成
                    
                    // 检查实体是否成功生成
                    try {
                        await player.runCommandAsync(`testfor @e[type=${recordedEntity.type},x=${x},y=${y},z=${z},r=1]`);
                        // 给新生成的实体添加标签
                        await player.runCommandAsync(`tag @e[type=${recordedEntity.type},x=${x},y=${y},z=${z},r=1,tag=!recorded_entity] add recorded_entity`);
                        await player.runCommandAsync(`tag @e[type=${recordedEntity.type},x=${x},y=${y},z=${z},r=1,tag=recorded_entity,tag=!${TEMP_TAG}] add ${TEMP_TAG}`);
                        console.warn(`成功生成新实体: ${recordedEntity.type} at (${x}, ${y}, ${z})`);
                    } catch (error) {
                        console.warn(`实体生成失败: ${recordedEntity.type} at (${x}, ${y}, ${z}): ${error}`);
                        // 再尝试一次生成
                        await player.runCommandAsync(`summon ${recordedEntity.type} ${x} ${y} ${z}`);
                    }
                } catch (error) {
                    console.warn(`无法生成实体 ${recordedEntity.type} at (${x}, ${y}, ${z}): ${error}`);
                }
            }
        } catch (error) {
            console.warn(`还原实体时出错 ${recordedEntity.type}: ${error}`);
        }
        
        // 每个实体处理后添加短暂延迟
        await delay(1);
    }

    // 清除临时标签
    try {
        await player.runCommandAsync(`tag @e[tag=${TEMP_TAG}] remove ${TEMP_TAG}`);
    } catch (error) {
        console.warn(`清除临时标签时出错: ${error}`);
    }
}

// 还原方块的函数
async function restoreBlocks(player, dimension) {
    let successCount = 0;
    let failCount = 0;

    try {
        // 将相同类型、Y坐标和Z坐标的方块分组，这样可以找到更大的连续区域
        const blockGroups = {};
        for (const blockData of worldState.blocks) {
            const key = `${blockData.type}_${blockData.location.y}_${blockData.location.z}`;
            if (!blockGroups[key]) {
                blockGroups[key] = {
                    type: blockData.type,
                    y: blockData.location.y,
                    z: blockData.location.z,
                    xLocations: []
                };
            }
            blockGroups[key].xLocations.push(blockData.location.x);
        }

        // 按类型和坐标批量还原方块
        for (const key in blockGroups) {
            const group = blockGroups[key];
            // 对X坐标排序，方便找到连续区域
            group.xLocations.sort((a, b) => a - b);
            
            let startX = group.xLocations[0];
            let endX = startX;
            
            // 查找连续的X坐标区域
            for (let i = 1; i <= group.xLocations.length; i++) {
                const currentX = group.xLocations[i];
                
                // 如果不连续或到达末尾，执行fill命令
                if (i === group.xLocations.length || currentX !== endX + 1) {
                    try {
                        // 使用fill命令填充连续区域
                        const cmd = `fill ${startX} ${group.y} ${group.z} ${endX} ${group.y} ${group.z} ${group.type}`;
                        await player.runCommandAsync(cmd);
                        const blocksInThisCommand = endX - startX + 1;
                        successCount += blocksInThisCommand;
                        
                        // 每1000个方块更新一次进度
                        if (successCount % 1000 === 0) {
                            player.sendMessage(`§e已还原 ${successCount}/${worldState.blocks.length} 个方块...`);
                            // 每1000个方块后添加极短延迟
                            await delay(0);
                        }
                    } catch (error) {
                        console.warn(`无法还原方块区域 ${group.type} 从 ${startX} ${group.y} ${group.z} 到 ${endX} ${group.y} ${group.z}: ${error}`);
                        failCount += (endX - startX + 1);
                    }

                    // 开始新的区域
                    if (i < group.xLocations.length) {
                        startX = currentX;
                        endX = currentX;
                    }
                } else {
                    // 继续扩展当前区域
                    endX = currentX;
                }
            }
        }
    } catch (error) {
        console.warn("还原方块时出错：" + error);
    }

    return { successCount, failCount };
}

// 还原世界状态的主函数
async function restoreWorldState(player) {
    try {
        if (!worldState) {
            player.sendMessage("§c没有已记录的世界状态！");
            return;
        }

        const dimension = player.dimension;
        player.sendMessage(`§e开始还原世界状态，共有 ${worldState.blocks.length} 个方块需要还原...`);

        // 还原游戏时间
        const totalTicks = worldState.dayCount * 24000 + worldState.timeOfDay;
        await player.runCommandAsync(`time set ${totalTicks}`);

        // 还原方块
        const { successCount, failCount } = await restoreBlocks(player, dimension);

        // 还原实体
        await restoreEntities(player, dimension);

        // 输出还原结果
        player.sendMessage("§a已还原到记录的世界状态！");
        console.warn("=== 世界状态还原完成 ===");
        console.warn(`还原到游戏天数: ${worldState.dayCount}`);
        console.warn(`还原到当天时间: ${worldState.timeOfDay}`);
        console.warn(`还原的实体数量: ${worldState.entities.length}`);
        console.warn(`还原的方块数量: ${worldState.blocks.length}`);
        console.warn(`成功还原方块: ${successCount}`);
        console.warn(`失败还原方块: ${failCount}`);

    } catch (error) {
        console.warn("还原世界状态时出错：" + error);
        player.sendMessage("§c还原世界状态失败！");
    }
}

// 监听聊天命令
world.beforeEvents.chatSend.subscribe((eventData) => {
    const message = eventData.message.toLowerCase();
    const player = eventData.sender;

    switch (message) {
        case "test":
            eventData.cancel = true;
            recordWorldState(player);
            break;
        case "回溯":
            eventData.cancel = true;
            restoreWorldState(player).catch(error => {
                console.warn("执行还原命令时出错：" + error);
                player.sendMessage("§c还原世界状态失败！");
            });
            break;
    }
});

// 脚本加载提示
console.warn("世界状态记录脚本已加载！");



